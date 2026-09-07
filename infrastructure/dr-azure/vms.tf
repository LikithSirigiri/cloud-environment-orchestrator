# storage account backing each VM's blobfuse mount (the app data container)
data "azurerm_storage_account" "dr_storage" {
  name                = var.storage_account_name
  resource_group_name = data.azurerm_resource_group.rg[var.resource_group_name].name
}

# local map of every VM plus which subnet/PIP it needs
locals {
  # container_names comes from the backend, which lists the storage account and
  # matches containers against VM names (see /api/deploy in server.js). Running
  # terraform directly without the backend falls back to guessing the role name
  # from the VM name instead.
  vm_to_container_map = {
    for vm_name in keys(var.vm_sizes) :
    vm_name => lookup(var.container_names, vm_name, try(regex("^[^-]+-([a-z0-9]+)-server", lower(vm_name))[0], lower(vm_name)))
  }

  all_vms = {
    for vm_name in keys(var.vm_sizes) :
    vm_name => {
      # public IP is opt-in via var.public_ip_vms, never inferred from the name
      # (e.g. "web"/"kong"). keeps it optional for every role, none are mandatory.
      is_public               = contains(var.public_ip_vms, vm_name)
      existing_public_ip_name = lookup(var.existing_public_ip_names, vm_name, null)
      # all VMs share the one subnet now, no more public/private split.
      # access control moved to the NIC-level NSG below.
      subnet_id = local.subnet_id
      # web/kong need 443 open, plus 22 for terraform's own provisioning check.
      # everything else just gets 22 from inside the vnet.
      nsg_id    = length(regexall("(?i).*(web|kong).*", vm_name)) > 0 ? azurerm_network_security_group.web_or_kong_nsg.id : azurerm_network_security_group.internal_nsg.id
      container = local.vm_to_container_map[vm_name]
      # each server can override its resource group via resource_group_names,
      # falls back to the shared default when it's not listed.
      resource_group_name = data.azurerm_resource_group.rg[lookup(var.resource_group_names, vm_name, var.resource_group_name)].name
    }
  }

  public_vms = {
    for k, v in local.all_vms : k => v if v.is_public
  }

  # most public VMs just get a fresh public IP. existing_public_ip_names lets one
  # point at an IP that was created ahead of time (e.g. by hand in the portal)
  # instead. Azure public IP names/addresses are immutable, so importing the
  # wrong one would force a destroy+recreate and hand back a different address -
  # which defeats the whole point of pinning a specific IP.
  new_public_ip_vms = {
    for k, v in local.public_vms : k => v if v.existing_public_ip_name == null
  }
  existing_public_ip_vms = {
    for k, v in local.public_vms : k => v if v.existing_public_ip_name != null
  }
}

# new public IPs, for public VMs that don't point at an existing one
resource "azurerm_public_ip" "vm_pip" {
  for_each = local.new_public_ip_vms

  name                = "${each.key}-pip"
  location            = var.location
  resource_group_name = each.value.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

# looked-up public IPs, for VMs pointing at ones that already exist
data "azurerm_public_ip" "existing_vm_pip" {
  for_each = local.existing_public_ip_vms

  name                = each.value.existing_public_ip_name
  resource_group_name = each.value.resource_group_name
}

locals {
  # resolved id/address per public VM, regardless of which of the two sources it
  # came from. downstream code reads these locals instead of picking between
  # azurerm_public_ip.vm_pip and data.azurerm_public_ip.existing_vm_pip directly.
  vm_public_ip_id = merge(
    { for k, v in azurerm_public_ip.vm_pip : k => v.id },
    { for k, v in data.azurerm_public_ip.existing_vm_pip : k => v.id }
  )
  vm_public_ip_address = merge(
    { for k, v in azurerm_public_ip.vm_pip : k => v.ip_address },
    { for k, v in data.azurerm_public_ip.existing_vm_pip : k => v.ip_address }
  )
}

# Network Interfaces
resource "azurerm_network_interface" "vm_nic" {
  for_each = local.all_vms

  name                = "${each.key}-nic"
  location            = var.location
  resource_group_name = each.value.resource_group_name
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = each.value.subnet_id
    private_ip_address_allocation = "Dynamic"

    public_ip_address_id = each.value.is_public ? local.vm_public_ip_id[each.key] : null
  }
}

resource "azurerm_network_interface_security_group_association" "vm_nsg_assoc" {
  for_each = local.all_vms

  network_interface_id      = azurerm_network_interface.vm_nic[each.key].id
  network_security_group_id = each.value.nsg_id
}

# Virtual Machines
resource "azurerm_linux_virtual_machine" "vm" {
  for_each = local.all_vms

  name                = each.key
  computer_name       = replace(each.key, "_", "-")
  location            = var.location
  resource_group_name = each.value.resource_group_name
  size                = var.vm_sizes[each.key]
  admin_username      = var.admin_username

  network_interface_ids = [
    azurerm_network_interface.vm_nic[each.key].id,
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
    disk_size_gb         = lookup(var.disk_sizes, each.key, var.default_disk_size)
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.tftpl", {
    storage_account_name = var.storage_account_name
    storage_account_key  = data.azurerm_storage_account.dr_storage.primary_access_key
    container_name       = each.value.container
    mount_path           = lookup(var.blobfuse_mount_paths, each.key, var.default_blobfuse_mount_path)
    # mirrors the blob container's own top-level layout onto the VM's real
    # filesystem root. whatever structure the data already has in Blob Storage
    # is exactly what shows up on the VM - nothing else to configure here.
    app_data_path     = "/"
    admin_username    = var.admin_username
    is_web_server     = length(regexall(".*web.*", each.key)) > 0
    is_web_or_kong    = length(regexall(".*(web|kong).*", each.key)) > 0
    is_central_server = length(regexall(".*central.*", each.key)) > 0
    ip_replacements   = { for k, old_ip in var.old_ips : old_ip => azurerm_network_interface.vm_nic[k].private_ip_address if contains(keys(azurerm_network_interface.vm_nic), k) }
  }))

  tags = var.tags
}

# blocks terraform and streams cloud-init logs until it's done
resource "null_resource" "cloud_init_wait" {
  for_each = local.all_vms

  depends_on = [
    azurerm_linux_virtual_machine.vm,
    azurerm_public_ip.vm_pip,
    data.azurerm_public_ip.existing_vm_pip,
    azurerm_network_interface.vm_nic,
    azurerm_network_interface_security_group_association.vm_nsg_assoc,
    azurerm_subnet_nat_gateway_association.shared_nat_assoc
  ]

  connection {
    type        = "ssh"
    user        = var.admin_username
    password    = var.vm_authentication_type == "password" ? var.admin_password : null
    private_key = var.vm_authentication_type == "ssh_key" ? tls_private_key.vm_ssh[0].private_key_pem : null
    # public IP for web/kong, private IP otherwise
    host = each.value.is_public ? local.vm_public_ip_address[each.key] : azurerm_network_interface.vm_nic[each.key].private_ip_address

    # private VMs jump through any public VM as a bastion host
    bastion_host        = each.value.is_public ? null : try([for k, v in local.public_vms : local.vm_public_ip_address[k]][0], null)
    bastion_user        = each.value.is_public ? null : var.admin_username
    bastion_password    = each.value.is_public || var.vm_authentication_type == "ssh_key" ? null : var.admin_password
    bastion_private_key = each.value.is_public || var.vm_authentication_type == "password" ? null : tls_private_key.vm_ssh[0].private_key_pem
  }

  provisioner "remote-exec" {
    inline = [
      "echo 'Waiting for cloud-init to finish and streaming logs...'",
      # stream the full log from line 1, in the background
      "sudo tail -n +1 -f /var/log/cloud-init-output.log & TAIL_PID=$!",
      # wait here until cloud-init is fully done. output goes to /dev/null since
      # it's just a "." printed every second - pure noise, the tail above already
      # streams anything worth seeing. exit code still comes through fine even
      # with stdout/stderr redirected, and that's what we check below.
      "cloud-init status --wait > /dev/null 2>&1",
      # kill the log stream, we're done with it
      "sudo kill $TAIL_PID || true",
      # cloud-init happily reports "done" even when our provisioning script blew
      # up partway through - a failed runcmd item doesn't stop the boot sequence.
      # so check the script's own status file instead: a real failure (bad mount,
      # empty container, copy error, whatever) needs to fail this provisioner,
      # and with it the whole terraform apply, rather than silently look like
      # success with nothing actually copied.
      "STATUS=$(sudo cat /var/lib/cloud/dr_provision_status 2>/dev/null || echo 'FAILED: status file missing'); echo \"Provisioning status: $STATUS\"; [ \"$STATUS\" = \"SUCCESS\" ] || { echo 'Provisioning did not complete successfully, see /var/log/cloud-init-output.log on the VM for details'; exit 1; }"
    ]
  }
}
