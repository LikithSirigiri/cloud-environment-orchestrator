output "nsg_id" {
  value = azurerm_network_security_group.nsg.id
}

output "nsg_id_https" { value = azurerm_network_security_group.nsg.id }
#output "nsg_id_ssh" { value = azurerm_network_security_group.ssh_rule.id }
