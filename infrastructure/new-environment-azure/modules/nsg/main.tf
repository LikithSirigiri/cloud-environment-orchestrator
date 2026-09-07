resource "azurerm_network_security_group" "nsg" {
  name                = "web-nsg"
  location            = var.location
  resource_group_name = var.resource_group_name
}

# SSH Rule
resource "azurerm_network_security_rule" "ssh" {
  name                    = "ssh-rule"
  priority                = 100
  direction               = "Inbound"
  access                  = "Allow"
  protocol                = "Tcp"
  source_address_prefixes = var.ssh_allowed_ips
  #source_address_prefix       = "*"
  destination_address_prefix  = "*"
  destination_port_range      = "22"
  source_port_range           = "*"
  network_security_group_name = azurerm_network_security_group.nsg.name
  resource_group_name         = var.resource_group_name
}

# HTTPS Rule
resource "azurerm_network_security_rule" "https" {
  name                        = "https-rule"
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_address_prefixes     = var.https_allowed_ips
  destination_address_prefix  = "*"
  destination_port_range      = "443"
  source_port_range           = "*"
  network_security_group_name = azurerm_network_security_group.nsg.name
  resource_group_name         = var.resource_group_name
}