output "public_ip_names" {
  #value = keys(module.vms.public_ips)
  value = module.vms.all_public_ips
}

output "all_private_ips" {
  value = module.vms.private_ips
}

output "domain" {
  value = var.domain
}

output "all_public_ips_only" {
  description = "Public IPs of servers from VM module"
  value       = module.vms.all_public_ips_only
}

output "storageblob_key" {
  value     = module.network.storageblob_key
  sensitive = true
}

output "storageblob_string" {
  value     = module.network.storageblob_string
  sensitive = true
}

output "storageblob_name" {
  value = module.network.storageblob_name
}

##output "all_private_ips" {
##  value = {
##    APP_SERVER     = azurerm_network_interface.app_server.private_ip_address
##    CENTRAL_SERVER = azurerm_network_interface.central_server.private_ip_address
##    DB_SERVER      = azurerm_network_interface.db_server.private_ip_address
##    WEB_SERVER     = azurerm_network_interface.web_server.private_ip_address
##    KONG_SERVER    = azurerm_network_interface.kong_server.private_ip_address
##  }
##}
##
##output "public_ips" {
##  value = {
##    WEB_SERVER     = azurerm_public_ip.web_server.ip_address
##    DB_SERVER      = azurerm_public_ip.db_server.ip_address
##  }
##}
#output "client_id" {
#  value = module.deploymentfilesmovement.client_id
#}
#
#output "client_name" {
#  value = module.deploymentfilesmovement.client_name
#}
#
#output "client_secret" {
#  value     = module.deploymentfilesmovement.client_secret
#  sensitive = true
#}

#output "rsa_keys_json" {
#  value = module.deploymentfilesmovement.rsa_keys_json
#}

#output "keycloak_public_dns" {
#  value = aws_instance.keycloak.public_dns
#}
