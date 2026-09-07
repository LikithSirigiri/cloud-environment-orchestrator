# VPC + one public (web) subnet + two private (app/db) subnets + a single NAT
# gateway. Same proven shape as aws/main.tf's DR flow
# (dr_vpc/dr_public/dr_private/dr_nat_gw/dr_igw), just parameterized by client
# name and CIDR vars instead of hardcoded DR values.
#
# Create-vs-existing follows the same pattern as azure/network.tf's
# create_vnet/create_subnet: a resource + a data source per toggleable thing,
# complementary counts, reconciled into one "_effective" local. Every
# downstream reference (this file's own routing, plus this module's outputs
# consumed by modules/security + modules/ec2) only ever touches the
# "_effective" locals, so callers don't need to care whether something was
# created here or just looked up.

data "aws_availability_zones" "available" {
  state = "available"
}

# --- VPC ---

resource "aws_vpc" "vpc" {
  count                = var.create_vpc ? 1 : 0
  cidr_block           = var.vpc_cidr[0]
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-vpc"
    ManagedBy = "Terraform"
  })
}

data "aws_vpc" "existing" {
  count = var.create_vpc ? 0 : 1
  id    = var.existing_vpc_id
}

locals {
  vpc_id_effective = var.create_vpc ? aws_vpc.vpc[0].id : data.aws_vpc.existing[0].id
}

# --- Internet Gateway: only relevant to a *new* web subnet's route to it.
# Created alongside a new VPC; looked up on an existing VPC only when we're
# also creating new subnets inside it (a purely-existing-subnets deployment
# never touches routing at all, so no IGW reference is needed there). ---

resource "aws_internet_gateway" "igw" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = local.vpc_id_effective

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-igw"
    ManagedBy = "Terraform"
  })
}

data "aws_internet_gateway" "existing" {
  count = (!var.create_vpc && var.create_subnets) ? 1 : 0
  filter {
    name   = "attachment.vpc-id"
    values = [local.vpc_id_effective]
  }
}

locals {
  igw_id_effective = var.create_vpc ? aws_internet_gateway.igw[0].id : (
    var.create_subnets ? data.aws_internet_gateway.existing[0].id : null
  )
}

# --- Subnets ---

resource "aws_subnet" "web" {
  count                   = var.create_subnets ? 1 : 0
  vpc_id                  = local.vpc_id_effective
  cidr_block              = var.web_subnet_prefixes[0]
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-web-subnet"
    ManagedBy = "Terraform"
  })
}

data "aws_subnet" "web" {
  count = var.create_subnets ? 0 : 1
  id    = var.existing_web_subnet_id
}

resource "aws_subnet" "app" {
  count             = var.create_subnets ? 1 : 0
  vpc_id            = local.vpc_id_effective
  cidr_block        = var.app_subnet_prefixes[0]
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-app-subnet"
    ManagedBy = "Terraform"
  })
}

data "aws_subnet" "app" {
  count = var.create_subnets ? 0 : 1
  id    = var.existing_app_subnet_id
}

resource "aws_subnet" "db" {
  count             = var.create_subnets ? 1 : 0
  vpc_id            = local.vpc_id_effective
  cidr_block        = var.db_subnet_prefixes[0]
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-db-subnet"
    ManagedBy = "Terraform"
  })
}

data "aws_subnet" "db" {
  count = var.create_subnets ? 0 : 1
  id    = var.existing_db_subnet_id
}

locals {
  web_subnet_id_effective = var.create_subnets ? aws_subnet.web[0].id : data.aws_subnet.web[0].id
  app_subnet_id_effective = var.create_subnets ? aws_subnet.app[0].id : data.aws_subnet.app[0].id
  db_subnet_id_effective  = var.create_subnets ? aws_subnet.db[0].id : data.aws_subnet.db[0].id
}

# --- Routing (public route table + NAT gateway + private route table).
# Only happens when create_subnets = true - existing subnets already have
# whatever routing their owner set up, and this module leaves that alone. ---

resource "aws_route_table" "public" {
  count  = var.create_subnets ? 1 : 0
  vpc_id = local.vpc_id_effective

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = local.igw_id_effective
  }

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-public-rt"
    ManagedBy = "Terraform"
  })
}

resource "aws_route_table_association" "web" {
  count          = var.create_subnets ? 1 : 0
  subnet_id      = local.web_subnet_id_effective
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count  = var.create_subnets ? 1 : 0
  domain = "vpc"

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-nat-eip"
    ManagedBy = "Terraform"
  })
}

resource "aws_nat_gateway" "nat" {
  count         = var.create_subnets ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = local.web_subnet_id_effective

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-nat-gateway"
    ManagedBy = "Terraform"
  })

  depends_on = [aws_internet_gateway.igw]
}

resource "aws_route_table" "private" {
  count  = var.create_subnets ? 1 : 0
  vpc_id = local.vpc_id_effective

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat[0].id
  }

  tags = merge(var.custom_tags, {
    Name      = "${var.client_name}-private-rt"
    ManagedBy = "Terraform"
  })
}

resource "aws_route_table_association" "app" {
  count          = var.create_subnets ? 1 : 0
  subnet_id      = local.app_subnet_id_effective
  route_table_id = aws_route_table.private[0].id
}

resource "aws_route_table_association" "db" {
  count          = var.create_subnets ? 1 : 0
  subnet_id      = local.db_subnet_id_effective
  route_table_id = aws_route_table.private[0].id
}
