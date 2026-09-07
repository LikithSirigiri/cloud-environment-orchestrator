locals {
  # every resource group we actually touch: the default (network/storage plus
  # any VM without an override), each per-VM override in resource_group_names,
  # and the mongo override if one's set.
  mongo_resource_group_name = var.mongo_resource_group_name != null && var.mongo_resource_group_name != "" ? var.mongo_resource_group_name : var.resource_group_name
  all_resource_group_names = toset(concat(
    [var.resource_group_name, local.mongo_resource_group_name],
    values(var.resource_group_names)
  ))
}

data "azurerm_resource_group" "rg" {
  for_each = local.all_resource_group_names
  name     = each.value
}

# create_vnet decides whether we build the vnet or just look one up. Terraform
# resource blocks can't be conditionally resource-vs-data-source, so both exist
# here with opposite counts and a local below resolves to whichever one is real.
resource "azurerm_virtual_network" "vnet" {
  count               = var.create_vnet ? 1 : 0
  name                = var.vnet_name
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
  address_space       = var.vnet_address_space
  tags                = var.tags
}

data "azurerm_virtual_network" "vnet" {
  count               = var.create_vnet ? 0 : 1
  name                = var.vnet_name
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
}

locals {
  vnet_name_effective = var.create_vnet ? azurerm_virtual_network.vnet[0].name : data.azurerm_virtual_network.vnet[0].name
}

# one subnet for everything - web, kong, app, central, mongo. No public/private
# split; NIC-level NSGs handle per-role access instead. Same create-or-lookup
# pattern as the vnet above.
resource "azurerm_subnet" "shared" {
  count                = var.create_subnet ? 1 : 0
  name                 = var.subnet_name
  resource_group_name  = data.azurerm_resource_group.rg[var.resource_group_name].name
  virtual_network_name = local.vnet_name_effective
  address_prefixes     = [var.subnet_address_prefix]
}

data "azurerm_subnet" "shared" {
  count                = var.create_subnet ? 0 : 1
  name                 = var.subnet_name
  virtual_network_name = local.vnet_name_effective
  resource_group_name  = data.azurerm_resource_group.rg[var.resource_group_name].name
}

locals {
  subnet_id = var.create_subnet ? azurerm_subnet.shared[0].id : data.azurerm_subnet.shared[0].id
}

# NAT gateway, same create-or-lookup pattern as above. a fresh one needs its own
# public IP (Standard SKU requires it) - an existing one already has that covered.
resource "azurerm_public_ip" "nat_pip" {
  count               = var.create_nat_gateway ? 1 : 0
  name                = "${var.nat_gateway_name}-pip"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "nat" {
  count               = var.create_nat_gateway ? 1 : 0
  name                = var.nat_gateway_name
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "nat_pip_assoc" {
  count                = var.create_nat_gateway ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.nat[0].id
  public_ip_address_id = azurerm_public_ip.nat_pip[0].id
}

data "azurerm_nat_gateway" "nat" {
  count               = var.create_nat_gateway ? 0 : 1
  name                = var.nat_gateway_name
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
}

locals {
  nat_gateway_id = var.create_nat_gateway ? azurerm_nat_gateway.nat[0].id : data.azurerm_nat_gateway.nat[0].id
}

// only touch this association if the subnet or NAT gateway is actually new.
// if both already existed, they're already linked in Azure (a subnet can only
// have one NAT gateway) - "creating" it again would just collide with what's there.
resource "azurerm_subnet_nat_gateway_association" "shared_nat_assoc" {
  count          = (var.create_subnet || var.create_nat_gateway) ? 1 : 0
  subnet_id      = local.subnet_id
  nat_gateway_id = local.nat_gateway_id
}

# NSGs are always created fresh here (an existing vnet/subnet won't already have
# role-specific ones) and attached at the NIC level in vms.tf/mongo.tf - one
# shared subnet can't apply different rules per VM role on its own.
resource "azurerm_network_security_group" "web_or_kong_nsg" {
  name                = "web-kong-nsg"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
  tags                = var.tags

  security_rule {
    name                       = "Allow-HTTPS-Inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # left open to the internet rather than VNet-scoped, so terraform's own
  # SSH-based provisioning check (null_resource.cloud_init_wait) still works the
  # same way it did back when web/kong lived in the public subnet.
  security_rule {
    name                       = "Allow-SSH-Inbound"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "internal_nsg" {
  name                = "internal-nsg"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
  tags                = var.tags

  security_rule {
    name                       = "Allow-SSH-VNet"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }
}
