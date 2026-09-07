# Network Interfaces for MongoDB Servers
resource "azurerm_network_interface" "mongo_nic" {
  count               = var.mongo_server_count
  name                = "acme-mongo-server-${count.index + 1}-dr-nic"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[local.mongo_resource_group_name].name
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = local.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}

# mongo falls into "the others" bucket - just 22 from inside the vnet, no public access.
resource "azurerm_network_interface_security_group_association" "mongo_nsg_assoc" {
  count = var.mongo_server_count

  network_interface_id      = azurerm_network_interface.mongo_nic[count.index].id
  network_security_group_id = azurerm_network_security_group.internal_nsg.id
}

# Virtual Machines for MongoDB
resource "azurerm_linux_virtual_machine" "mongo_vm" {
  count               = var.mongo_server_count
  name                = "acme-mongo-server-${count.index + 1}-dr"
  computer_name       = "acme-mongo-server-${count.index + 1}-dr"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg[local.mongo_resource_group_name].name

  # fixed VM size for mongo (could switch to var.vm_size if that ever needs to vary)
  size           = var.mongo_vm_size
  admin_username = var.admin_username

  network_interface_ids = [
    azurerm_network_interface.mongo_nic[count.index].id,
  ]

  admin_password                  = var.vm_authentication_type == "password" ? var.admin_password : null
  disable_password_authentication = var.vm_authentication_type == "ssh_key"

  dynamic "admin_ssh_key" {
    for_each = var.vm_authentication_type == "ssh_key" ? [1] : []
    content {
      username   = var.admin_username
      public_key = tls_private_key.vm_ssh[0].public_key_openssh
    }
  }

  secure_boot_enabled = true
  vtpm_enabled        = true

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = var.os_disk_type
    disk_size_gb         = var.mongo_os_disk_size
  }

  source_image_reference {
    publisher = var.os_publisher
    offer     = var.os_offer
    sku       = var.os_sku
    version   = var.os_version
  }

  identity {
    type = "SystemAssigned"
  }

  custom_data = base64encode(templatefile("${path.module}/mongo-init.tftpl", {
    mongo_version = var.mongo_version
  }))

  tags = var.tags
}
