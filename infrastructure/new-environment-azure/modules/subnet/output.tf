output "app_rg" {
  value = azurerm_resource_group.rg["app"].name
}

output "web_rg" {
  value = azurerm_resource_group.rg["web"].name
}

output "db_rg" {
  value = azurerm_resource_group.rg["db"].name
}

output "security_rg" {
  value = azurerm_resource_group.rg["security"].name
}