###############################################################################
# AZURE RESOURCE GROUP / NETWORKING
###############################################################################

variable "resource_group_name" {
  description = "Name of the existing Azure Resource Group used by default: the shared network (VNet/subnet/NSGs/NAT), the storage account lookup, and any VM not given its own entry in resource_group_names"
  type        = string
}

variable "resource_group_names" {
  description = "Map of VM name to the existing Resource Group it should live in instead of resource_group_name. Every server can have its own resource group, not just a single named exception; VMs not listed here use resource_group_name."
  type        = map(string)
  default     = {}
}

variable "location" {
  description = "Azure region to deploy DR resources into"
  type        = string
}

variable "create_vnet" {
  description = "Create a new Virtual Network named vnet_name instead of looking up an existing one"
  type        = bool
  default     = false
}

variable "vnet_name" {
  description = "Name of the Virtual Network: an existing one to look up (create_vnet = false), or the name to give a newly created one (create_vnet = true)"
  type        = string
}

variable "vnet_address_space" {
  description = "Address space for the Virtual Network. Only used when create_vnet is true."
  type        = list(string)
  default     = ["10.0.0.0/16"]
}

variable "create_subnet" {
  description = "Create a new subnet named subnet_name instead of looking up an existing one"
  type        = bool
  default     = false
}

variable "subnet_name" {
  description = "Name of the subnet (within vnet_name) that every VM's NIC is placed into. There's a single shared subnet, not separate public/private ones. An existing one to look up (create_subnet = false), or the name to give a newly created one (create_subnet = true)."
  type        = string
}

variable "subnet_address_prefix" {
  description = "Address prefix (CIDR) for the subnet. Only used when create_subnet is true."
  type        = string
  default     = "10.0.1.0/24"
}

variable "create_nat_gateway" {
  description = "Create a new NAT gateway (with its own public IP) named nat_gateway_name instead of looking up an existing one"
  type        = bool
  default     = false
}

variable "nat_gateway_name" {
  description = "Name of the NAT gateway associated with subnet_name: an existing one to look up (create_nat_gateway = false), or the name to give a newly created one (create_nat_gateway = true)"
  type        = string
}

variable "tags" {
  description = "Tags applied to all Azure resources"
  type        = map(string)
  default     = {}
}

###############################################################################
# AZURE VM AUTHENTICATION
###############################################################################

variable "admin_username" {
  description = "Admin username for the Azure VMs"
  type        = string
}

variable "admin_password" {
  description = "Admin password for the Azure VMs (used when vm_authentication_type is \"password\")"
  type        = string
  default     = null
  sensitive   = true
}

variable "vm_authentication_type" {
  description = "How to authenticate to the Azure VMs: \"password\" or \"ssh_key\""
  type        = string
  default     = "password"
}

variable "vm_ssh_key_name" {
  description = "Filename (without extension) for the generated SSH private key, when vm_authentication_type is \"ssh_key\""
  type        = string
  default     = "dr-vm-key"
}

###############################################################################
# AZURE VM SIZING / OS DISK
###############################################################################

variable "vm_sizes" {
  description = "Map of VM name to Azure VM size (e.g. Standard_B4als_v2)"
  type        = map(string)
  default     = {}
}

variable "disk_sizes" {
  description = "Map of VM name to OS disk size in GiB"
  type        = map(number)
  default     = {}
}

variable "public_ip_vms" {
  description = "Names (from vm_sizes) of VMs that should get a public IP and sit in the public subnet. Not automatic based on name (e.g. \"web\"/\"kong\"): a public IP is optional for every VM, including web/kong servers, and only assigned when explicitly listed here."
  type        = set(string)
  default     = []
}

variable "existing_public_ip_names" {
  description = "Map of VM name to the name of an already-existing Azure Public IP (in that VM's resource group) to attach instead of creating a new one. Only consulted for VMs also listed in public_ip_vms; every other public VM still gets a newly created public IP."
  type        = map(string)
  default     = {}
}

variable "default_disk_size" {
  description = "OS disk size in GiB used for any VM not present in disk_sizes"
  type        = number
  default     = 30
}

variable "os_disk_type" {
  description = "Azure managed disk storage account type for VM OS disks (e.g. StandardSSD_LRS, Premium_LRS)"
  type        = string
  default     = "StandardSSD_LRS"
}

variable "os_publisher" {
  description = "Marketplace image publisher for the VM OS disk"
  type        = string
  default     = "Canonical"
}

variable "os_offer" {
  description = "Marketplace image offer for the VM OS disk"
  type        = string
  default     = "ubuntu-24_04-lts"
}

variable "os_sku" {
  description = "Marketplace image SKU for the VM OS disk"
  type        = string
  default     = "server"
}

variable "os_version" {
  description = "Marketplace image version for the VM OS disk"
  type        = string
  default     = "latest"
}

###############################################################################
# AZURE STORAGE / BLOBFUSE MOUNTS
###############################################################################

variable "storage_account_name" {
  description = "Name of the existing Azure Storage Account mounted via blobfuse on the VMs"
  type        = string
}

variable "container_names" {
  description = "Map of VM name to the real blob container it mounts, resolved by the backend against the actual containers in storage_account_name. Falls back to a guessed role name for any VM not present here (e.g. when running terraform directly without going through the backend)."
  type        = map(string)
  default     = {}
}

variable "blobfuse_mount_paths" {
  description = "Map of VM name to blobfuse mount path, overriding default_blobfuse_mount_path"
  type        = map(string)
  default     = {}
}

variable "default_blobfuse_mount_path" {
  description = "Default blobfuse mount path used for any VM not present in blobfuse_mount_paths"
  type        = string
  default     = "/mnt/appdata"
}

###############################################################################
# AZURE IP REPLACEMENT (cloud-init config templating)
###############################################################################

variable "old_ips" {
  description = "Map of old (DC) private IP address to server name, used to rewrite references to old IPs on the new VMs"
  type        = map(string)
  default     = {}
}

###############################################################################
# AZURE MONGODB SERVERS
###############################################################################

variable "mongo_server_count" {
  description = "Number of MongoDB VMs to provision on Azure"
  type        = number
  default     = 0
}

variable "mongo_resource_group_name" {
  description = "Resource Group for all MongoDB VMs, overriding resource_group_name. Mongo VMs are count-based (auto-named), not individually named like the other servers, so this is one shared override rather than a per-VM map."
  type        = string
  default     = null
}

variable "mongo_version" {
  description = "MongoDB major version to install on the Azure database servers"
  type        = string
  default     = "7.0"
}

variable "mongo_vm_size" {
  description = "Azure VM size for MongoDB servers"
  type        = string
  default     = "Standard_B2s"
}

variable "mongo_os_disk_size" {
  description = "OS disk size in GiB for MongoDB servers"
  type        = number
  default     = 30
}
