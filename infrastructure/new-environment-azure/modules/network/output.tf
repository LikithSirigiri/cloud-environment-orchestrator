output "app_subnet_id" {
  #value = azurerm_subnet.this["app"].id
  value = azurerm_subnet.app.id
}

output "web_subnet_id" {
  value = azurerm_subnet.web.id
}

output "db_subnet_id" {
  value = azurerm_subnet.db.id
}

output "nat_gateway_public_ip" {
  value = azurerm_public_ip.nat_pip.ip_address
}

output "storageblob_key" {
  value     = azurerm_storage_account.storageblob.primary_access_key
  sensitive = true
}

output "storageblob_string" {
  value     = azurerm_storage_account.storageblob.primary_blob_connection_string
  sensitive = true
}
output "storageblob_name" {
  value = azurerm_storage_account.storageblob.name
}