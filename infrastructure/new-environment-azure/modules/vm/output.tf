output "public_ips" {
  value = {
    #for name, pip in azurerm_public_ip.vm_pip :
    #name => pip.ip_address
    for name, cfg in var.servers :
    name => try(azurerm_public_ip.vm_pip[name].ip_address, null)
  }
}

output "private_ips" {
  description = "Map of VM names to their private IPs"
  value = {
    for name, nic in azurerm_network_interface.nic :
    name => nic.ip_configuration[0].private_ip_address
  }
}

output "all_public_ips" {
  value = { for name, nic in azurerm_network_interface.nic :
  name => try(nic.ip_configuration[0].public_ip_address_id, null) }
}

output "all_public_ips_only" {
  description = "Public IPs of servers that have public IPs"
  value       = { for name, pip in azurerm_public_ip.vm_pip : name => try(pip.ip_address, "") }
}

output "vm_ids" {
  value = { for k, v in azurerm_linux_virtual_machine.vm : k => v.id }
}

#output "mongo_private_ips" {
#  description = "Private IPs of MongoDB servers"
#  value       = local.mongo_private_ips
#}