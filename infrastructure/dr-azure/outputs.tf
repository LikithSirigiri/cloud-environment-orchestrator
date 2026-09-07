output "vm_public_ips" {
  description = "Public IP addresses of the Web and Kong VMs"
  value = {
    for k, v in azurerm_public_ip.vm_pip : k => v.ip_address
  }
}

output "vm_private_ips" {
  description = "Private IP addresses of all VMs"
  value = {
    for k, v in azurerm_network_interface.vm_nic : k => v.private_ip_address
  }
}

output "mongo_private_ips" {
  description = "Private IP addresses of MongoDB VMs"
  value = {
    for i, v in azurerm_network_interface.mongo_nic : "acme-mongo-server-${i + 1}-dr" => v.private_ip_address
  }
}
