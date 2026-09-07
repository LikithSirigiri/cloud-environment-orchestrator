# AWS equivalent of azure-new-env/modules/nsg. A public SG (SSH/HTTPS from the
# allowed-IP lists, applied only to the web instance - same two-rule shape as
# the single Azure NSG) plus a private SG (SSH + all traffic from the public SG
# only), same pattern already proven in aws/main.tf's dr_private_sg/dr_db_sg.

resource "aws_security_group" "public" {
  name        = "${var.client_name}-public-sg"
  description = "Allows SSH and HTTPS from the configured allow-lists for the web instance"
  vpc_id      = var.vpc_id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_ips
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.https_allowed_ips
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-public-sg"
    ManagedBy = "Terraform"
  })
}

resource "aws_security_group" "private" {
  name        = "${var.client_name}-private-sg"
  description = "Allows SSH and all traffic from the public SG only (app/db/central/kong instances)"
  vpc_id      = var.vpc_id

  ingress {
    description     = "SSH from the public tier only"
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.public.id]
  }

  ingress {
    description     = "All traffic from the public tier"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.public.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-private-sg"
    ManagedBy = "Terraform"
  })
}
