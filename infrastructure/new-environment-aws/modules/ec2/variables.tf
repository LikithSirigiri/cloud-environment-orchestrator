variable "client_name" {
  type = string
}

variable "custom_tags" {
  type    = map(string)
  default = {}
}

variable "ssh_username" {
  type    = string
  default = "ubuntu"
}

variable "key_pair_mode" {
  type = string
}

variable "existing_key_pair_name" {
  type    = string
  default = ""
}

variable "servers" {
  type = map(object({
    instance_type     = string
    subnet_id         = string
    security_group_id = string
    disk_size         = number
    public_ip         = bool
    install_docker    = bool
    install_mongo     = bool
  }))
  description = "Map of instances to create with their configuration"
}
