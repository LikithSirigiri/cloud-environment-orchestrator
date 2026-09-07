resource "azurerm_public_ip" "vm_pip" {
  for_each = { for name, cfg in var.servers : name => cfg if cfg.public_ip }

  name                = "${var.client_name}-${each.key}-pip"
  location            = var.location
  resource_group_name = each.value.rg_name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "nic" {
  for_each = var.servers

  name                = "${var.client_name}-${each.key}-nic"
  location            = var.location
  resource_group_name = each.value.rg_name

  ip_configuration {
    name                          = "internal"
    private_ip_address_allocation = "Dynamic"
    subnet_id                     = each.value.subnet_id
    public_ip_address_id          = try(azurerm_public_ip.vm_pip[each.key].id, null)
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  for_each = var.servers

  name                            = "${var.client_name}-${each.key}"
  computer_name                   = replace(each.key, "_", "-")
  disable_password_authentication = false
  location                        = var.location
  resource_group_name             = each.value.rg_name
  network_interface_ids           = [azurerm_network_interface.nic[each.key].id]
  size                            = each.value.vm_size
  admin_username                  = var.admin_username
  admin_password                  = var.admin_password

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = each.value.disk_size
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }

  # only docker/mongo bootstrap goes through cloud-init here. nginx gets
  # installed later via the deploymentfiles module's SSH remote-exec step.
  custom_data = each.value.install_docker || each.value.install_mongo ? base64encode(templatefile(
    each.value.install_docker ? local.docker_script : local.mongo_script,
    {}
  )) : null

  tags = {
    client-name = var.client_name
    CreatedOn   = formatdate("YYYY-MM-DD", timestamp())
  }
}
