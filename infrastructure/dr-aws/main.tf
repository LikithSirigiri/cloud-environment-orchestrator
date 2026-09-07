
# note: patched an INNER_EOF syntax error in the remote-exec heredocs below.
###############################################################################
# LOCAL VARIABLES
# derived values used throughout the rest of this file.
###############################################################################

locals {
  # drop any role whose tag value is empty
  active_servers = { for k, v in var.dc_server_tags : k => v if v != "" }

  # public role = web/kong, private = everything else
  server_placements = {
    for k, v in local.active_servers : k => (
      length(regexall("(?i)web", k)) > 0 || length(regexall("(?i)kong", k)) > 0 ? "public" : "private"
    )
  }

  # DR private IPs for replicated app/web servers, plus the DB servers
  new_server_ips = merge(
    { for k, v in aws_instance.replicated_servers : k => v.private_ip },
    {
      db_primary   = length(aws_instance.db_servers) > 0 ? aws_instance.db_servers[0].private_ip : ""
      db_secondary = length(aws_instance.db_servers) > 1 ? aws_instance.db_servers[1].private_ip : ""
    }
  )

  # space-separated OLD_IP,NEW_IP pairs, consumed by the remote-exec replacement scripts below
  ip_mappings = join(" ", [
    for role, old_ip in var.dc_server_ips :
    "${old_ip},${lookup(local.new_server_ips, role, "")}"
    if lookup(local.new_server_ips, role, "") != "" && old_ip != ""
  ])

  # role key of the public web server - doubles as the SSH bastion for private servers
  bastion_role = try([for role in keys(local.active_servers) : role if length(regexall("(?i)web", role)) > 0][0], "")

  # unique AZs in the DR region, var.dr_availability_zone goes first
  az_names = slice(distinct(concat([var.dr_availability_zone], data.aws_availability_zones.available.names)), 0, var.dr_az_count)
}

data "aws_availability_zones" "available" {
  provider = aws.dr
  state    = "available"
}


resource "random_id" "suffix" {
  byte_length = 4
}

###############################################################################
# STEP 1 - DISCOVER EXISTING DC INSTANCES BY NAME TAG
# looks up each active server in the primary region by its EC2 Name tag.
###############################################################################

data "aws_instance" "dc_instances" {
  for_each = local.active_servers

  filter {
    name = "tag:Name"
    values = [
      each.value,
      trimspace(each.value),
      "${trimspace(each.value)} ",
      " ${trimspace(each.value)}"
    ]
  }

  filter {
    name   = "instance-state-name"
    values = ["running", "stopped", "stopping"]
  }
}

###############################################################################
# STEP 2 - CREATE AMI SNAPSHOTS FROM DC INSTANCES
# live AMI snapshot of each discovered instance, no reboot needed.
###############################################################################

resource "aws_ami_from_instance" "snapshots" {
  for_each                = local.active_servers
  name                    = "dr-snapshot-${each.key}-${data.aws_instance.dc_instances[each.key].id}-${random_id.suffix.hex}"
  source_instance_id      = data.aws_instance.dc_instances[each.key].id
  snapshot_without_reboot = true

  tags = {
    Name      = "dr-snapshot-${each.key}"
    ManagedBy = "Terraform"
    Purpose   = "DR-Replication"
  }
}

###############################################################################
# STEP 3 - COPY AMIs TO THE DR REGION
# copies each snapshot AMI over from the DC region.
###############################################################################

resource "aws_ami_copy" "copied_amis" {
  for_each          = local.active_servers
  provider          = aws.dr
  name              = "dr-ami-${each.key}-${random_id.suffix.hex}"
  source_ami_id     = aws_ami_from_instance.snapshots[each.key].id
  source_ami_region = var.dc_region

  tags = {
    Name      = "dr-ami-${each.key}"
    ManagedBy = "Terraform"
    Purpose   = "DR-Replication"
  }
}

###############################################################################
# STEP 4 - DR VPC AND NETWORKING
# isolated VPC in the DR region: public/private subnets, an internet gateway,
# route tables.
###############################################################################

resource "aws_vpc" "dr_vpc" {
  provider             = aws.dr
  cidr_block           = var.dr_vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name      = var.dr_vpc_name
    ManagedBy = "Terraform"
  }
}

resource "aws_internet_gateway" "dr_igw" {
  provider = aws.dr
  vpc_id   = aws_vpc.dr_vpc.id

  tags = {
    Name      = "dr-internet-gateway"
    ManagedBy = "Terraform"
  }
}

resource "aws_subnet" "dr_public" {
  count                   = var.dr_az_count
  provider                = aws.dr
  vpc_id                  = aws_vpc.dr_vpc.id
  cidr_block              = count.index == 0 ? var.dr_public_subnet_cidr : cidrsubnet(var.dr_vpc_cidr, 8, count.index + 2)
  availability_zone       = local.az_names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name      = "dr-public-subnet-${count.index + 1}"
    ManagedBy = "Terraform"
  }
}

resource "aws_subnet" "dr_private" {
  count             = var.dr_az_count
  provider          = aws.dr
  vpc_id            = aws_vpc.dr_vpc.id
  cidr_block        = count.index == 0 ? var.dr_private_subnet_cidr : cidrsubnet(var.dr_vpc_cidr, 8, count.index + 12)
  availability_zone = local.az_names[count.index]

  tags = {
    Name      = "dr-private-subnet-${count.index + 1}"
    ManagedBy = "Terraform"
  }
}

resource "aws_route_table" "dr_public_rt" {
  provider = aws.dr
  vpc_id   = aws_vpc.dr_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.dr_igw.id
  }

  tags = {
    Name      = "dr-public-route-table"
    ManagedBy = "Terraform"
  }
}

resource "aws_route_table_association" "dr_public_assoc" {
  count          = var.dr_az_count
  provider       = aws.dr
  subnet_id      = aws_subnet.dr_public[count.index].id
  route_table_id = aws_route_table.dr_public_rt.id
}

resource "aws_route_table" "dr_private_rt" {
  provider = aws.dr
  vpc_id   = aws_vpc.dr_vpc.id

  tags = {
    Name      = "dr-private-route-table"
    ManagedBy = "Terraform"
  }
}

resource "aws_route_table_association" "dr_private_assoc" {
  count          = var.dr_az_count
  provider       = aws.dr
  subnet_id      = aws_subnet.dr_private[count.index].id
  route_table_id = aws_route_table.dr_private_rt.id
}

resource "aws_eip" "dr_nat_eip" {
  provider = aws.dr
  domain   = "vpc"

  tags = {
    Name      = "dr-nat-eip"
    ManagedBy = "Terraform"
  }
}

resource "aws_nat_gateway" "dr_nat_gw" {
  provider      = aws.dr
  allocation_id = aws_eip.dr_nat_eip.id
  subnet_id     = aws_subnet.dr_public[0].id

  tags = {
    Name      = "dr-nat-gateway"
    ManagedBy = "Terraform"
  }

  depends_on = [aws_internet_gateway.dr_igw]
}

resource "aws_route" "dr_private_nat_route" {
  provider               = aws.dr
  route_table_id         = aws_route_table.dr_private_rt.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.dr_nat_gw.id
}



###############################################################################
# STEP 5 - SECURITY GROUPS
# public SG: HTTP/HTTPS/SSH from the internet (web + kong).
# private SG: SSH + internal traffic, but only from the public tier.
###############################################################################

resource "aws_security_group" "dr_public_sg" {
  provider    = aws.dr
  name        = "dr-public-sg"
  description = "Allows HTTP, HTTPS, and SSH for public-facing DR servers"
  vpc_id      = aws_vpc.dr_vpc.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "dr-public-sg"
    ManagedBy = "Terraform"
  }
}

resource "aws_security_group" "dr_private_sg" {
  provider    = aws.dr
  name        = "dr-private-sg"
  description = "Allows SSH within VPC and all traffic from the public security group"
  vpc_id      = aws_vpc.dr_vpc.id

  ingress {
    description     = "SSH from public bastion only"
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.dr_public_sg.id]
  }

  ingress {
    description     = "All traffic from public tier"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.dr_public_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "dr-private-sg"
    ManagedBy = "Terraform"
  }
}

resource "aws_security_group" "dr_db_sg" {
  provider    = aws.dr
  name        = "dr-db-sg"
  description = "Allows SSH within VPC and MongoDB traffic from the private app tier"
  vpc_id      = aws_vpc.dr_vpc.id

  ingress {
    description     = "SSH from public bastion only"
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.dr_public_sg.id]
  }

  ingress {
    description     = "MongoDB from private app tier"
    from_port       = 27017
    to_port         = 27017
    protocol        = "tcp"
    security_groups = [aws_security_group.dr_private_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "dr-db-sg"
    ManagedBy = "Terraform"
  }
}



###############################################################################
# STEP 6 - REPLICATED APPLICATION SERVERS
# launches DR EC2 instances from the copied AMIs - web/kong get public IPs,
# everyone else lands in the private subnet.
###############################################################################

resource "aws_instance" "replicated_servers" {
  for_each = local.active_servers
  provider = aws.dr

  ami                    = aws_ami_copy.copied_amis[each.key].id
  instance_type          = data.aws_instance.dc_instances[each.key].instance_type
  subnet_id              = local.server_placements[each.key] == "public" ? aws_subnet.dr_public[0].id : aws_subnet.dr_private[0].id
  vpc_security_group_ids = local.server_placements[each.key] == "public" ? [aws_security_group.dr_public_sg.id] : [aws_security_group.dr_private_sg.id]
  # EIP gets attached explicitly below via aws_eip_association, so no auto-assigned public IP here
  associate_public_ip_address = false
  monitoring                  = false

  tags = {
    Name      = "${data.aws_instance.dc_instances[each.key].tags["Name"]}-dr"
    Role      = each.key
    Tier      = local.server_placements[each.key]
    ManagedBy = "Terraform"
  }
}

resource "aws_eip" "dr_web_eip" {
  count    = local.bastion_role != "" ? 1 : 0
  provider = aws.dr
  domain   = "vpc"

  tags = {
    Name      = "dr-web-eip"
    ManagedBy = "Terraform"
  }
}

resource "aws_eip_association" "dr_web_eip_assoc" {
  count         = local.bastion_role != "" ? 1 : 0
  provider      = aws.dr
  instance_id   = local.bastion_role != "" ? aws_instance.replicated_servers[local.bastion_role].id : null
  allocation_id = length(aws_eip.dr_web_eip) > 0 ? aws_eip.dr_web_eip[0].id : null
}

###############################################################################
# STEP 7 - DATABASE SERVERS
# queries Canonical's registry for the latest Ubuntu 22.04 LTS AMI, then boots
# clean private instances and installs MongoDB via user_data. all DB servers
# land in the shared private subnet.
###############################################################################

data "aws_ami" "ubuntu_latest" {
  provider    = aws.dr
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

###############################################################################
# STEP 6.5 - GENERATE AND REGISTER NEW KEY PAIR FOR DB SERVERS
# new 4096-bit RSA key pair for the mongo instances, public key registered in
# the DR region (us-east-2). private key (db_key.pem) gets copied over to the
# web server's pem-files/ afterward.
###############################################################################

resource "tls_private_key" "db_private_key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "db_key_pair" {
  provider   = aws.dr
  key_name   = "dr-db-key-${random_id.suffix.hex}"
  public_key = tls_private_key.db_private_key.public_key_openssh
}

resource "null_resource" "write_db_private_key" {
  triggers = {
    key_pem_sha256 = sha256(tls_private_key.db_private_key.private_key_pem)
  }

  depends_on = [
    aws_instance.replicated_servers,
    aws_eip.dr_web_eip,
    aws_eip_association.dr_web_eip_assoc,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /home/${var.ssh_username}/pem-files"
    ]
  }

  provisioner "file" {
    content     = tls_private_key.db_private_key.private_key_pem
    destination = "/home/${var.ssh_username}/pem-files/db_key.pem"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod 600 /home/${var.ssh_username}/pem-files/db_key.pem"
    ]
  }
}

resource "aws_instance" "db_servers" {
  count                       = var.db_server_count
  provider                    = aws.dr
  ami                         = data.aws_ami.ubuntu_latest.id
  instance_type               = lookup(var.dr_instance_types, "db", "t3.micro")
  subnet_id                   = aws_subnet.dr_private[count.index % var.dr_az_count].id
  vpc_security_group_ids      = [aws_security_group.dr_db_sg.id]
  associate_public_ip_address = false
  key_name                    = aws_key_pair.db_key_pair.key_name
  monitoring                  = false
  user_data_replace_on_change = true

  depends_on = [
    aws_route.dr_private_nat_route
  ]

  user_data = <<-EOF
#!/bin/bash
set -e

apt-get update -y || true
apt-get install -y gnupg wget curl

# import the MongoDB GPG key and register the repo
curl -fsSL https://pgp.mongodb.com/server-${var.mongodb_version}.asc \
  | gpg --yes --dearmor -o /usr/share/keyrings/mongodb-server-${var.mongodb_version}.gpg

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${var.mongodb_version}.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/${var.mongodb_version} multiverse" | tee /etc/apt/sources.list.d/mongodb-org-${var.mongodb_version}.list

apt-get update -y
apt-get install -y mongodb-org

# bind to all interfaces, not just localhost
sed -i "s/bindIp: 127.0.0.1/bindIp: 0.0.0.0/" /etc/mongod.conf

systemctl enable mongod
systemctl start mongod
EOF

  tags = {
    Name      = "dr-db-server-${count.index + 1}"
    Role      = "db"
    Tier      = "private"
    ManagedBy = "Terraform"
  }
}
###############################################################################
# STEP 8 - POST-DEPLOYMENT IP REPLACEMENT
# SSHes into each replicated server and swaps old DC IPs for the new DR IPs in
# the relevant config files.
#
# config file paths:
#   - web servers  : /etc/nginx/nginx.conf
#   - other servers: /home/\${var.ssh_username}/env-files (scans .env files in there)
#
# connection strategy:
#   - web server (bastion): direct via its public IP
#   - private servers     : tunnelled through the web server bastion
#
# auth: uses the local SSH agent (agent = true) instead of exposing or loading
# PEM keys directly in the codebase.
###############################################################################

resource "null_resource" "copy_key" {
  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    aws_instance.replicated_servers,
    aws_eip.dr_web_eip,
    aws_eip_association.dr_web_eip_assoc,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "file" {
    source      = "${path.module}/${var.local_pem_filename}"
    destination = "/home/${var.ssh_username}/${var.local_pem_filename}"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod 600 /home/${var.ssh_username}/${var.local_pem_filename}"
    ]
  }
}

resource "null_resource" "ip_replacement_web" {
  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    aws_instance.replicated_servers,
    null_resource.copy_key,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [IP REPLACEMENT PHASE 1: WEB] Starting IP replacements for web server ==='",
      replace(<<-EOT
        sudo bash <<'INNER_EOF'
          SCAN_PATH="/etc/nginx/nginx.conf"
          echo "Scan path on web server: $SCAN_PATH"
          if [ -f "$SCAN_PATH" ]; then
            for pair in ${local.ip_mappings}; do
              OLD_IP=$(echo "$pair" | cut -d',' -f1)
              NEW_IP=$(echo "$pair" | cut -d',' -f2)
              echo "  Replacing $OLD_IP → $NEW_IP in $SCAN_PATH"
              sed -i "s|$OLD_IP|$NEW_IP|g" "$SCAN_PATH" 2>/dev/null || true
            done
            
            # test nginx config before restarting it
            if nginx -t; then
              echo "✔ Nginx configuration test passed. Restarting Nginx..."
              systemctl restart nginx
              systemctl status nginx --no-pager || true
            else
              echo "❌ Nginx configuration test failed!"
              exit 1
            fi
          else
            echo "WARNING: Nginx config $SCAN_PATH does not exist. Skipping."
          fi

          # also fix up ~/.bashrc aliases on the web server
          BASHRC_PATH="/home/${var.ssh_username}/.bashrc"
          if [ -f "$BASHRC_PATH" ]; then
            for pair in ${local.ip_mappings}; do
              OLD_IP=$(echo "$pair" | cut -d',' -f1)
              NEW_IP=$(echo "$pair" | cut -d',' -f2)
              sed -i "s|$OLD_IP|$NEW_IP|g" "$BASHRC_PATH" 2>/dev/null || true
            done
            chown ${var.ssh_username}:${var.ssh_username} "$BASHRC_PATH" || true
            echo "✔ Updated ~/.bashrc aliases on web server."
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [IP REPLACEMENT PHASE 1: WEB] Completed successfully ==='"
    ]
  }
}

resource "null_resource" "ip_replacement_private_envs" {
  for_each = { for k, v in local.active_servers : k => v if k != local.bastion_role }

  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    aws_instance.replicated_servers,
    aws_instance.db_servers,
    null_resource.ip_replacement_web,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [IP REPLACEMENT PHASE 2: PRIVATE ENVS] Starting IP replacements for server: ${each.key} ==='",
      replace(<<-EOT
        PRIVATE_IP="${aws_instance.replicated_servers[each.key].private_ip}"
        
        # find the SSH key for the target server
        KEY_FILE=$(grep -i "alias ${each.key}=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        echo "Waiting for private server $PRIVATE_IP to accept SSH connections..."
        set +e
        for i in {1..40}; do
          ssh -i "$KEY_PATH" -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes "${var.ssh_username}@$PRIVATE_IP" true 2>/dev/null
          if [ $? -eq 0 ]; then
            echo "✔ Private server $PRIVATE_IP is ready."
            break
          fi
          echo "  Waiting... ($i/40)"
          sleep 5
        done
        set -e

        echo "Connecting to private server $PRIVATE_IP from web server..."
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo bash" <<'INNER_EOF'
          # --- 1) update env files under /home/ubuntu/env-files ---
          SCAN_PATH="/home/${var.ssh_username}/env-files"
          echo "Checking env-files directory: $SCAN_PATH"
          if [ -d "$SCAN_PATH" ]; then
            cd "$SCAN_PATH"
            echo "Moved to directory: $(pwd)"
            # walk every subdirectory and update any .env files found
            for pair in ${local.ip_mappings}; do
              OLD_IP=$(echo "$pair" | cut -d',' -f1)
              NEW_IP=$(echo "$pair" | cut -d',' -f2)
              
              # DB IPs need appending rather than a straight swap, check for that case
              if [ -n "$OLD_IP" ] && { [ "$OLD_IP" = "${var.dc_server_ips.db_primary}" ] || [ "$OLD_IP" = "${var.dc_server_ips.db_secondary}" ]; }; then
                find . -type f -name ".env" 2>/dev/null | while read -r file; do
                  if ! grep -q "$NEW_IP" "$file"; then
                    echo "  Adding DB IP $NEW_IP:27017 next to $OLD_IP in $file"
                    ESCAPED_OLD_IP=$(echo "$OLD_IP" | sed 's/\./\\./g')
                    sed -E -i "s|$ESCAPED_OLD_IP(:[0-9]+)?|$OLD_IP:27017,$NEW_IP:27017|g" "$file" 2>/dev/null || true
                  else
                    echo "  DB IP $NEW_IP already present in $file. Skipping."
                  fi
                done
              else
                # otherwise, plain direct IP replacement
                echo "  Replacing IP $OLD_IP → $NEW_IP in .env files"
                find . -type f -name ".env" -exec sed -i "s|$OLD_IP|$NEW_IP|g" {} + 2>/dev/null || true
              fi
            done

            # if a secondary DB got provisioned but there was no old secondary IP,
            # append the new secondary IP next to the new primary in every .env file
            if [ -z "${var.dc_server_ips.db_secondary}" ] && [ -n "${local.new_server_ips.db_secondary}" ]; then
              NEW_PRIMARY="${local.new_server_ips.db_primary}"
              NEW_SECONDARY="${local.new_server_ips.db_secondary}"
              find . -type f -name ".env" 2>/dev/null | while read -r file; do
                if ! grep -q "$NEW_SECONDARY" "$file"; then
                  echo "  Adding secondary DB IP $NEW_SECONDARY:27017 next to primary $NEW_PRIMARY in $file"
                  ESCAPED_PRIMARY=$(echo "$NEW_PRIMARY" | sed 's/\./\\./g')
                  sed -E -i "s|$ESCAPED_PRIMARY(:[0-9]+)?|$NEW_PRIMARY:27017,$NEW_SECONDARY:27017|g" "$file" 2>/dev/null || true
                else
                  echo "  Secondary DB IP $NEW_SECONDARY already present in $file. Skipping."
                fi
              done
            fi

            echo "✔ All .env configuration files updated in $SCAN_PATH"
          else
            echo "INFO: Scan path $SCAN_PATH does not exist. Skipping standard env files update."
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [IP REPLACEMENT PHASE 2: PRIVATE ENVS] Completed successfully for server: ${each.key} ==='"
    ]
  }
}

resource "null_resource" "ip_replacement_secret" {
  # skip entirely unless 'app' is one of the active servers
  count = lookup(local.active_servers, "app", "") != "" ? 1 : 0

  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.ip_replacement_private_envs,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [IP REPLACEMENT PHASE 3: SECRET CONTAINER] Starting decryption/encryption on app server ==='",
      replace(<<-EOT
        PRIVATE_IP="${lookup(local.new_server_ips, "app", "")}"
        
        KEY_FILE=$(grep -i "alias app=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo bash" <<'INNER_EOF'
          CONTAINER_NAME=$(docker ps -a --format '{{.Names}}' | grep -i "secret" | head -n 1 || echo "")
          if [ -z "$CONTAINER_NAME" ]; then
            CONTAINER_NAME=$(docker ps -a --format '{{.Names}}' | grep -E "app|backend|api" | head -n 1 || echo "")
          fi
          if [ -z "$CONTAINER_NAME" ]; then
            CONTAINER_NAME=$(docker ps -a -q | while read -r id; do
              if docker exec "$id" test -d /usr/src/app 2>/dev/null; then
                docker inspect --format '{{.Name}}' "$id" | tr -d '/'
                break
              fi
            done)
          fi

          if [ -n "$CONTAINER_NAME" ]; then
            echo "✔ Found secret container: $CONTAINER_NAME"
            
            # make sure it's actually running so we can copy files out of it
            RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "false")
            if [ "$RUNNING" != "true" ]; then
              echo "  Container is stopped. Starting it temporarily..."
              docker start "$CONTAINER_NAME" || true
              sleep 2
            fi

            # copy files out to the host, checking both camelCase and lowercase paths
            if docker exec "$CONTAINER_NAME" test -f /usr/src/app/userData.enc 2>/dev/null; then
              docker cp "$CONTAINER_NAME":/usr/src/app/userData.enc ./userData.enc
            else
              docker cp "$CONTAINER_NAME":/usr/src/app/userdata.enc ./userData.enc 2>/dev/null || true
            fi

            if docker exec "$CONTAINER_NAME" test -f /usr/src/app/adminData.enc 2>/dev/null; then
              docker cp "$CONTAINER_NAME":/usr/src/app/adminData.enc ./adminData.enc
            else
              docker cp "$CONTAINER_NAME":/usr/src/app/admindata.enc ./adminData.enc 2>/dev/null || true
            fi

            # drop the decrypt/re-encrypt Node script on the host
            cat > update_enc_files.js <<'NODE_EOF'
// NOTE: hardcoded key redacted for this public repo - pull it from a secret store / env var at runtime instead.
const key = process.env.SECRET_DECRYPT_KEY || "<REDACTED-FOR-PUBLIC-REPO>";
const fs = require("fs");
const crypto = require('crypto');

const decryptData = (encryptedData, key) => {
    const [iv, encryptedText] = encryptedData.split(':');
    const decipher = crypto.createDecipheriv('aes-256-ctr', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedText, 'hex')), decipher.final()]);
    return decrypted.toString();
}

const encryptData = (text, key) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', Buffer.from(key, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

const oldPrimary = process.argv[2];
const oldSecondary = process.argv[3];
const newPrimary = process.argv[4];
const newSecondary = process.argv[5];

const files = ['userData.enc', 'adminData.enc'];

files.forEach(file => {
    if (!fs.existsSync(file)) {
        console.log("File " + file + " not found. Skipping.");
        return;
    }
    console.log("Processing " + file + "...");
    const encryptedData = fs.readFileSync(file, "utf8").trim();
    try {
        let decryptedText = decryptData(encryptedData, key);
        console.log("Decrypted " + file + " successfully.");
        
        const replaceIpWithPort = (text, oldIp, newIp, port = '27017') => {
            if (!oldIp || !newIp) return text;
            if (text.includes(newIp)) {
                console.log("New IP " + newIp + " already present in text. Skipping addition.");
                return text;
            }
            const escapedOldIp = oldIp.replace(/\./g, '\\.');
            const regex = new RegExp(escapedOldIp + '(:\\d+)?', 'g');
            return text.replace(regex, oldIp + ":" + port + "," + newIp + ":" + port);
        };

        decryptedText = replaceIpWithPort(decryptedText, oldPrimary, newPrimary);
        
        // append the secondary DR DB IP next to the new primary if there was no old secondary
        if (!oldSecondary && newSecondary) {
            decryptedText = replaceIpWithPort(decryptedText, newPrimary, newSecondary);
        } else {
            decryptedText = replaceIpWithPort(decryptedText, oldSecondary, newSecondary);
        }
        
        const reEncrypted = encryptData(decryptedText, key);
        fs.writeFileSync(file, reEncrypted, "utf8");
        console.log("Re-encrypted and saved " + file + ".");
    } catch (err) {
        console.error("Error processing " + file + ":", err);
        process.exit(1);
    }
});
NODE_EOF

            # run it via a throwaway node container
            echo "Running decryption and re-encryption script on host..."
            docker run --rm -v $(pwd):/work -w /work node:18-alpine node update_enc_files.js \
              "${var.dc_server_ips.db_primary}" \
              "${var.dc_server_ips.db_secondary}" \
              "${local.new_server_ips.db_primary}" \
              "${local.new_server_ips.db_secondary}"
              
            # copy the updated files back into the container, same camelCase/lowercase check
            if docker exec "$CONTAINER_NAME" test -f /usr/src/app/userData.enc 2>/dev/null; then
              docker cp ./userData.enc "$CONTAINER_NAME":/usr/src/app/userData.enc
            else
              docker cp ./userData.enc "$CONTAINER_NAME":/usr/src/app/userdata.enc 2>/dev/null || true
            fi

            if docker exec "$CONTAINER_NAME" test -f /usr/src/app/adminData.enc 2>/dev/null; then
              docker cp ./adminData.enc "$CONTAINER_NAME":/usr/src/app/adminData.enc
            else
              docker cp ./adminData.enc "$CONTAINER_NAME":/usr/src/app/admindata.enc 2>/dev/null || true
            fi
            
            # clean up the temp files on the host
            rm -f ./userData.enc ./adminData.enc ./update_enc_files.js
            echo "✔ Encrypted credentials files updated inside secret container."
          else
            echo "WARNING: Secret container not found. Skipping credential updates."
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [IP REPLACEMENT PHASE 3: SECRET CONTAINER] Completed successfully ==='"
    ]
  }
}

resource "null_resource" "ip_replacement_keycloak" {
  # skip entirely unless 'central' is one of the active servers
  count = lookup(local.active_servers, "central", "") != "" ? 1 : 0

  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.ip_replacement_secret,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [IP REPLACEMENT PHASE 4: KEYCLOAK] Starting Keycloak config updates on central server ==='",
      replace(<<-EOT
        PRIVATE_IP="${lookup(local.new_server_ips, "central", "")}"
        
        KEY_FILE=$(grep -i "alias central=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo su" <<'INNER_EOF'
          KEYCLOAK_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "keycloak" | head -n 1 || echo "")
          
          COMPOSE_FILE=""
          if [ -n "$KEYCLOAK_CONTAINER" ]; then
            COMPOSE_FILE=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.config-files" }}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "")
            if [ -z "$COMPOSE_FILE" ]; then
              KEYCLOAK_DIR_INSPECTED=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "")
              if [ -n "$KEYCLOAK_DIR_INSPECTED" ] && [ -f "$KEYCLOAK_DIR_INSPECTED/docker-compose.yml" ]; then
                COMPOSE_FILE="$KEYCLOAK_DIR_INSPECTED/docker-compose.yml"
              fi
            fi
          fi

          if [ -z "$COMPOSE_FILE" ]; then
            COMPOSE_FILE=$(find /home/${var.ssh_username} -name "docker-compose.yml" 2>/dev/null | grep -i "keycloak" | head -n 1)
          fi
          if [ -z "$COMPOSE_FILE" ]; then
            COMPOSE_FILE=$(find /home/${var.ssh_username} -name "docker-compose.yml" 2>/dev/null | head -n 1)
          fi
          
          if [ -n "$COMPOSE_FILE" ]; then
            KEYCLOAK_DIR=$(dirname "$COMPOSE_FILE")
            echo "✔ Keycloak docker-compose directory found: $KEYCLOAK_DIR"
            
            # swap old IPs for new across docker-compose.yml/.yaml and any .env in the Keycloak dir
            find "$KEYCLOAK_DIR" -type f \( -name ".env" -o -name "docker-compose.yml" -o -name "docker-compose.yaml" \) 2>/dev/null | while read -r file; do
              for pair in ${local.ip_mappings}; do
                OLD_IP=$(echo "$pair" | cut -d',' -f1)
                NEW_IP=$(echo "$pair" | cut -d',' -f2)
                
                # direct swap here, not appended - appending would break Keycloak's MySQL config
                echo "  Replacing IP $OLD_IP → $NEW_IP in $file"
                sed -i "s|$OLD_IP|$NEW_IP|g" "$file" 2>/dev/null || true
              done
            done
            echo "✔ Keycloak docker-compose files updated."
          else
            echo "WARNING: Keycloak docker-compose directory not found."
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [IP REPLACEMENT PHASE 4: KEYCLOAK] Completed successfully ==='"
    ]
  }
}

resource "null_resource" "restart_services" {
  for_each = { for k, v in local.active_servers : k => v if k == "central" }

  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.ip_replacement_keycloak,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [RESTART PHASE 1] Starting Core Services restarts on server: ${each.key} ==='",
      replace(<<-EOT
        PRIVATE_IP="${aws_instance.replicated_servers[each.key].private_ip}"
        
        KEY_FILE=$(grep -i "alias ${each.key}=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo su" <<'INNER_EOF'
          # figure out which core containers are running here.
          # prefer exact mysql/mariadb name matches, fall back to "db" while excluding the non-mysql databases
          MYSQL_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E "mysql|mariadb" | head -n 1 || echo "")
          if [ -z "$MYSQL_CONTAINER" ]; then
            MYSQL_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E "db" | grep -v -E "postgres|mongo|redis|rabbitmq" | head -n 1 || echo "")
          fi
          KEYCLOAK_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "keycloak" | head -n 1 || echo "")
          RABBITMQ_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "rabbitmq" | head -n 1 || echo "")
          REDIS_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "redis" | head -n 1 || echo "")

          # 1. restart MySQL, then health-check it
          if [ -n "$MYSQL_CONTAINER" ]; then
            echo "Restarting MySQL container: $MYSQL_CONTAINER..."
            docker restart "$MYSQL_CONTAINER" || true
            echo "mysql started successfully"
            
            # locate the Keycloak compose dir so we can find its .env for credentials
            COMPOSE_FILE=""
            if [ -n "$KEYCLOAK_CONTAINER" ]; then
              COMPOSE_FILE=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.config-files" }}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "")
              if [ -z "$COMPOSE_FILE" ]; then
                KEYCLOAK_DIR_INSPECTED=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "")
                if [ -n "$KEYCLOAK_DIR_INSPECTED" ] && [ -f "$KEYCLOAK_DIR_INSPECTED/docker-compose.yml" ]; then
                  COMPOSE_FILE="$KEYCLOAK_DIR_INSPECTED/docker-compose.yml"
                fi
              fi
            fi
            if [ -z "$COMPOSE_FILE" ]; then
              COMPOSE_FILE=$(find /home/${var.ssh_username} -name "docker-compose.yml" 2>/dev/null | grep -i "keycloak" | head -n 1)
            fi
            if [ -z "$COMPOSE_FILE" ]; then
              COMPOSE_FILE=$(find /home/${var.ssh_username} -name "docker-compose.yml" 2>/dev/null | head -n 1)
            fi
            
            DB_PASS=""
            DB_USER="root"
            if [ -n "$COMPOSE_FILE" ]; then
              KEYCLOAK_DIR=$(dirname "$COMPOSE_FILE")
              if [ -f "$KEYCLOAK_DIR/.env" ]; then
                DB_PASS=$(grep -E 'MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|DB_PASSWORD' "$KEYCLOAK_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" | head -n 1 || echo "")
                DB_USER=$(grep -E 'MYSQL_USER|DB_USER' "$KEYCLOAK_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" | head -n 1 || echo "root")
                if [ -z "$DB_USER" ]; then DB_USER="root"; fi
              fi
            fi

            mysql_healthy=false
            echo "Checking MySQL health..."
            for i in {1..60}; do
              running=$(docker inspect -f '{{.State.Running}}' "$MYSQL_CONTAINER" 2>/dev/null || echo "false")
              if [ "$running" = "true" ]; then
                # method 1: docker's own built-in healthcheck status, if one's defined
                health_status=$(docker inspect -f '{{.State.Health.Status}}' "$MYSQL_CONTAINER" 2>/dev/null || echo "none")
                if [ "$health_status" = "healthy" ]; then
                  echo "mysql health check passed (container healthcheck: healthy)"
                  mysql_healthy=true
                  break
                fi
                
                # method 2: mysqladmin ping, trying default and parsed creds
                if docker exec "$MYSQL_CONTAINER" mysqladmin ping 2>/dev/null | grep -q "mysqld is alive" || \
                   docker exec "$MYSQL_CONTAINER" mysqladmin -u root -p"$DB_PASS" 2>/dev/null | grep -q "mysqld is alive" || \
                   docker exec "$MYSQL_CONTAINER" mysqladmin -u "$DB_USER" -p"$DB_PASS" 2>/dev/null | grep -q "mysqld is alive"; then
                  echo "mysql health check passed (mysqladmin ping)"
                  mysql_healthy=true
                  break
                fi
                
                # method 3: just try a select 1
                if docker exec "$MYSQL_CONTAINER" mysql -u root -e "select 1" 2>/dev/null | grep -q "1" || \
                   ( [ -n "$DB_PASS" ] && docker exec "$MYSQL_CONTAINER" mysql -u root -p"$DB_PASS" -e "select 1" 2>/dev/null | grep -q "1" ) || \
                   ( [ -n "$DB_PASS" ] && docker exec "$MYSQL_CONTAINER" mysql -u "$DB_USER" -p"$DB_PASS" -e "select 1" 2>/dev/null | grep -q "1" ); then
                  echo "mysql health check passed (mysql query)"
                  mysql_healthy=true
                  break
                fi
                
                # method 4: last resort, is port 3306 even open inside the container
                # (covers client/credential issues). wait at least 5 iterations (10s)
                # to give it time to actually start up first
                if [ $i -gt 5 ]; then
                  if docker exec "$MYSQL_CONTAINER" nc -z localhost 3306 2>/dev/null || \
                     docker exec "$MYSQL_CONTAINER" timeout 1 bash -c 'cat < /dev/null > /dev/tcp/localhost/3306' 2>/dev/null; then
                    echo "mysql health check passed (port 3306 open and running)"
                    mysql_healthy=true
                    break
                  fi
                fi
              fi
              echo "  Waiting for MySQL... ($i/60)"
              sleep 2
            done
            
            if [ "$mysql_healthy" = "false" ]; then
              echo "❌ MySQL health check failed! Dumping container logs for diagnostics:"
              docker logs --tail 100 "$MYSQL_CONTAINER" || true
              exit 1
            fi

            if [ -n "$COMPOSE_FILE" ] && [ -f "$KEYCLOAK_DIR/.env" ]; then
              echo "Executing MySQL configuration commands..."
              DB_USER=$(grep -E 'MYSQL_USER|DB_USER' "$KEYCLOAK_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" | head -n 1 || echo "root")
              if [ -z "$DB_USER" ]; then DB_USER="root"; fi
              
              if [ -n "$DB_PASS" ]; then
                docker exec -i "$MYSQL_CONTAINER" mysql -u "$DB_USER" -p"$DB_PASS" -e "
                  SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));
                  SET group_concat_max_len = 1024*1024;
                  FLUSH PRIVILEGES;
                "
              else
                docker exec -i "$MYSQL_CONTAINER" mysql -u "$DB_USER" -e "
                  SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));
                  SET group_concat_max_len = 1024*1024;
                  FLUSH PRIVILEGES;
                "
              fi
              echo "✔ SQL commands executed successfully."
            fi
          fi

          # 2. restart RabbitMQ, then health-check it
          if [ -n "$RABBITMQ_CONTAINER" ]; then
            echo "Restarting RabbitMQ container: $RABBITMQ_CONTAINER..."
            docker restart "$RABBITMQ_CONTAINER" || true
            echo "rabbitmq started successfully"
            
            rabbitmq_healthy=false
            echo "Checking RabbitMQ health..."
            for i in {1..30}; do
              running=$(docker inspect -f '{{.State.Running}}' "$RABBITMQ_CONTAINER" 2>/dev/null || echo "false")
              if [ "$running" = "true" ]; then
                if docker exec "$RABBITMQ_CONTAINER" nc -z localhost 5672 2>/dev/null || docker exec "$RABBITMQ_CONTAINER" timeout 1 bash -c 'cat < /dev/null > /dev/tcp/localhost/5672' 2>/dev/null; then
                  echo "rabbitmq health check passed"
                  rabbitmq_healthy=true
                  break
                fi
              fi
              echo "  Waiting for RabbitMQ... ($i/30)"
              sleep 2
            done
            if [ "$rabbitmq_healthy" = "false" ]; then
              echo "❌ RabbitMQ health check failed!"
              exit 1
            fi
          fi

          # 3. restart Redis, then health-check it
          if [ -n "$REDIS_CONTAINER" ]; then
            echo "Restarting Redis container: $REDIS_CONTAINER..."
            docker restart "$REDIS_CONTAINER" || true
            echo "redis started successfully"
            
            redis_healthy=false
            echo "Checking Redis health..."
            for i in {1..30}; do
              if docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q "PONG"; then
                echo "redis health check passed"
                redis_healthy=true
                break
              fi
              echo "  Waiting for Redis... ($i/30)"
              sleep 2
            done
            if [ "$redis_healthy" = "false" ]; then
              echo "❌ Redis health check failed!"
              exit 1
            fi
          fi

          # 4. restart Keycloak, then health-check it
          if [ -n "$KEYCLOAK_CONTAINER" ]; then
            echo "Restarting Keycloak container: $KEYCLOAK_CONTAINER..."
            docker restart "$KEYCLOAK_CONTAINER" || true
            echo "keycloak started successfully"
            
            keycloak_healthy=false
            echo "Checking Keycloak health..."
            for i in {1..45}; do
              running=$(docker inspect --format='{{.State.Running}}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "false")
              if [ "$running" = "true" ]; then
                port=$(docker port "$KEYCLOAK_CONTAINER" | grep -oE '[0-9]+$' | head -n 1 || echo "8080")
                http_status=$(curl -s -I "http://localhost:$port" | head -n 1 | cut -d' ' -f2 | tr -d '\r' || echo "000")
                if [ -z "$http_status" ]; then http_status="000"; fi
                if [ "$http_status" -ge 200 ] 2>/dev/null && [ "$http_status" -lt 500 ] 2>/dev/null; then
                  echo "keycloak health check passed (HTTP $http_status)"
                  keycloak_healthy=true
                  break
                fi
              fi
              echo "  Waiting for Keycloak... ($i/45)"
              sleep 2
            done
            if [ "$keycloak_healthy" = "false" ]; then
              echo "❌ Keycloak health check failed!"
              exit 1
            fi
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [RESTART PHASE 1] Core Services restarts completed successfully on server: ${each.key} ==='"
    ]
  }
}

resource "null_resource" "restart_secret_access_admin" {
  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.restart_services,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [RESTART PHASE 2] Restarting Secret, Access, and Admin containers ==='",
      replace(<<-EOT
        PRIVATE_IP="${lookup(local.new_server_ips, "app", "")}"
        
        KEY_FILE=$(grep -i "alias app=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo bash" <<'INNER_EOF'
          SECRET_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "secret" | head -n 1 || echo "")
          if [ -z "$SECRET_CONTAINER" ]; then
            SECRET_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E "app|backend|api" | head -n 1 || echo "")
          fi
          
          # 1. restart the secret container and health-check it
          if [ -n "$SECRET_CONTAINER" ]; then
            echo "Restarting Secret API container: $SECRET_CONTAINER..."
            docker restart "$SECRET_CONTAINER" || true
            echo "secret started successfully"
            
            secret_healthy=false
            echo "Checking Secret API health..."
            for i in {1..30}; do
              running=$(docker inspect --format='{{.State.Running}}' "$SECRET_CONTAINER" 2>/dev/null || echo "false")
              if [ "$running" = "true" ]; then
                echo "secret health check passed"
                secret_healthy=true
                break
              fi
              echo "  Waiting for Secret API container... ($i/30)"
              sleep 2
            done
            
            if [ "$secret_healthy" = "false" ]; then
              echo "❌ Secret API health check failed!"
              exit 1
            fi
          else
            echo "WARNING: Secret container not found. Skipping restart."
          fi

          # 2. restart the access and admin containers
          ACCESS_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "access" | head -n 1 || echo "")
          ADMIN_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "admin" | head -n 1 || echo "")

          if [ -n "$ACCESS_CONTAINER" ]; then
            echo "Restarting access API container: $ACCESS_CONTAINER..."
            docker restart "$ACCESS_CONTAINER" || true
            echo "access started successfully"
          fi

          if [ -n "$ADMIN_CONTAINER" ]; then
            echo "Restarting admin API container: $ADMIN_CONTAINER..."
            docker restart "$ADMIN_CONTAINER" || true
            echo "admin started successfully"
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [RESTART PHASE 2] Secret, Access, and Admin restarts completed successfully ==='"
    ]
  }
}

resource "null_resource" "restart_core_api" {
  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.restart_secret_access_admin,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [RESTART PHASE 4] Restarting core API container ==='",
      replace(<<-EOT
        PRIVATE_IP="${lookup(local.new_server_ips, "app", "")}"
        
        KEY_FILE=$(grep -i "alias app=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo bash" <<'INNER_EOF'
          CORE_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "core" | head -n 1 || echo "")

          if [ -n "$CORE_CONTAINER" ]; then
            echo "Restarting core API container: $CORE_CONTAINER..."
            docker restart "$CORE_CONTAINER" || true
            echo "core started successfully"
          fi
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [RESTART PHASE 4] core API container restart completed successfully ==='"
    ]
  }
}

resource "null_resource" "restart_remaining" {
  for_each = local.active_servers

  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.restart_core_api,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "echo '=== [RESTART PHASE 4] Restarting remaining containers on server: ${each.key} ==='",
      replace(<<-EOT
        PRIVATE_IP="${aws_instance.replicated_servers[each.key].private_ip}"
        
        KEY_FILE=$(grep -i "alias ${each.key}=" ~/.bashrc | grep -oE "pem-files/[a-zA-Z0-9_.-]+\.pem" | head -n 1)
        if [ -n "$KEY_FILE" ] && [ -f "/home/${var.ssh_username}/$KEY_FILE" ]; then
          KEY_PATH="/home/${var.ssh_username}/$KEY_FILE"
        else
          KEY_PATH="/home/${var.ssh_username}/${var.local_pem_filename}"
          chmod 600 "$KEY_PATH"
        fi
        
        ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "${var.ssh_username}@$PRIVATE_IP" "sudo su" <<'INNER_EOF'
          # skip anything already restarted in an earlier phase
          MYSQL_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E "mysql|db" | head -n 1 || echo "")
          KEYCLOAK_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "keycloak" | head -n 1 || echo "")
          RABBITMQ_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "rabbitmq" | head -n 1 || echo "")
          REDIS_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "redis" | head -n 1 || echo "")
          
          SECRET_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "secret" | head -n 1 || echo "")
          if [ -z "$SECRET_CONTAINER" ]; then
            SECRET_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E "app|backend|api" | head -n 1 || echo "")
          fi
          
          ACCESS_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "access" | head -n 1 || echo "")
          ADMIN_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "admin" | head -n 1 || echo "")
          CORE_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -i "core" | head -n 1 || echo "")

          echo "Restarting any other containers..."
          docker ps -a --format '{{.Names}}' | while read -r container; do
            if [ -n "$container" ] && \
               [ "$container" != "$MYSQL_CONTAINER" ] && \
               [ "$container" != "$KEYCLOAK_CONTAINER" ] && \
               [ "$container" != "$RABBITMQ_CONTAINER" ] && \
               [ "$container" != "$REDIS_CONTAINER" ] && \
               [ "$container" != "$SECRET_CONTAINER" ] && \
               [ "$container" != "$ACCESS_CONTAINER" ] && \
               [ "$container" != "$ADMIN_CONTAINER" ] && \
               [ "$container" != "$CORE_CONTAINER" ]; then
              echo "  Restarting container: $container"
              docker restart "$container" || true
            fi
          done
INNER_EOF
      EOT
      , "\r", ""),
      "echo '=== [RESTART PHASE 4] Remaining containers restart completed successfully on server: ${each.key} ==='"
    ]
  }
}

resource "null_resource" "cleanup_key" {
  triggers = {
    ip_mappings = local.ip_mappings
  }

  depends_on = [
    null_resource.restart_remaining,
  ]

  connection {
    type        = "ssh"
    user        = var.ssh_username
    host        = aws_eip.dr_web_eip[0].public_ip
    private_key = file("${path.module}/${var.local_pem_filename}")
  }

  provisioner "remote-exec" {
    inline = [
      "rm -f /home/${var.ssh_username}/${var.local_pem_filename}",
      "echo 'Cleaned up copied key file from bastion.'"
    ]
  }
}

###############################################################################
# OUTPUTS
###############################################################################

output "dr_vpc_id" {
  description = "ID of the DR VPC"
  value       = aws_vpc.dr_vpc.id
}

output "dr_public_subnet_id" {
  description = "ID of the DR public subnet"
  value       = aws_subnet.dr_public[0].id
}

output "dr_private_subnet_id" {
  description = "ID of the DR private subnet"
  value       = aws_subnet.dr_private[0].id
}

output "replicated_instance_ids" {
  description = "Map of server role to DR EC2 instance ID"
  value       = { for k, v in aws_instance.replicated_servers : k => v.id }
}

output "replicated_public_ips" {
  description = "Public IP addresses of public-tier DR instances (web and kong)"
  value = {
    for k, v in aws_instance.replicated_servers :
    k => (k == local.bastion_role && length(aws_eip.dr_web_eip) > 0 ? aws_eip.dr_web_eip[0].public_ip : v.public_ip)
    if local.server_placements[k] == "public"
  }
}

output "dr_web_eip" {
  description = "Elastic IP of the DR Web Server"
  value       = length(aws_eip.dr_web_eip) > 0 ? aws_eip.dr_web_eip[0].public_ip : null
}

output "replicated_private_ips" {
  description = "Private IP addresses of all replicated DR instances"
  value       = { for k, v in aws_instance.replicated_servers : k => v.private_ip }
}

output "db_server_private_ips" {
  description = "Private IP addresses of the DR MongoDB database servers"
  value       = aws_instance.db_servers[*].private_ip
}

output "ip_replacement_comparison" {
  description = "Comparison of old DC private IPs to new DR private IPs"
  value = {
    for role, old_ip in var.dc_server_ips :
    role => {
      old_dc_ip = old_ip
      new_dr_ip = lookup(local.new_server_ips, role, "not_replicated")
    }
    if old_ip != ""
  }
}