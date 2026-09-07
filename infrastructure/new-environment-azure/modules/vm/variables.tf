variable "location" {
  type = string
}

variable "admin_username" {
  type        = string
  description = "VM admin username"
}

variable "admin_password" {
  type        = string
  sensitive   = true
  description = "VM admin password"
}

variable "nsg_id" {
  type = string
}

variable "client_name" {
  type = string
}

variable "servers" {
  type = map(object({
    vm_size        = string
    rg_name        = string
    disk_size      = number
    subnet_id      = string
    public_ip      = bool
    install_docker = bool
    install_nginx  = bool
    install_mongo  = bool
  }))
  description = "Map of servers to create with their configuration"
}
