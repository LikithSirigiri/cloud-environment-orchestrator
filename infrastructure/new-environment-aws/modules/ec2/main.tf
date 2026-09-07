# AWS equivalent of azure-new-env/modules/vm. Same 5-server map shape, same
# fixed instance-size-by-role convention, Ubuntu 22.04 via the same AMI filter
# already proven in aws/main.tf's data.aws_ami.ubuntu_latest (owner 099720109477).

data "aws_ami" "ubuntu" {
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

# Key pair: "generate" creates and registers a brand-new key pair (same
# tls_private_key + aws_key_pair pattern already proven in aws/main.tf's DB key
# generation). "existing" looks up one already registered in this AWS
# account/region - same create-vs-existing convention used throughout this codebase.
resource "tls_private_key" "generated" {
  count     = var.key_pair_mode == "generate" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.key_pair_mode == "generate" ? 1 : 0
  key_name   = "${var.client_name}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags       = merge(var.custom_tags, { Name = "${var.client_name}-key" })
}

data "aws_key_pair" "existing" {
  count              = var.key_pair_mode == "existing" ? 1 : 0
  key_name           = var.existing_key_pair_name
  include_public_key = true
}

locals {
  key_name = var.key_pair_mode == "generate" ? aws_key_pair.generated[0].key_name : data.aws_key_pair.existing[0].key_name
}

resource "aws_instance" "server" {
  for_each = var.servers

  ami                         = data.aws_ami.ubuntu.id
  instance_type               = each.value.instance_type
  subnet_id                   = each.value.subnet_id
  vpc_security_group_ids      = [each.value.security_group_id]
  associate_public_ip_address = each.value.public_ip
  key_name                    = local.key_name
  monitoring                  = false

  root_block_device {
    volume_size = each.value.disk_size
    volume_type = "gp3"
  }

  # only docker/mongo bootstrap goes through user_data here too. nginx gets
  # installed later via the deploymentfiles module's SSH remote-exec step,
  # same as Azure's vm module.
  user_data = (
    each.value.install_docker ? file("${path.module}/../../scripts/docker.sh") :
    each.value.install_mongo ? file("${path.module}/../../scripts/mongo.sh") :
    null
  )

  tags = merge(var.custom_tags, {
    Name        = "${var.client_name}-${each.key}"
    client-name = var.client_name
    CreatedOn   = formatdate("YYYY-MM-DD", timestamp())
  })
}
