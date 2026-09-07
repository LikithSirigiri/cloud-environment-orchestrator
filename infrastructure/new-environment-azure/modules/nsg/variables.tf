variable "resource_group_name" {
  description = "Resource group for the NSG"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "List of IPs allowed for SSH (22)"
  type        = list(string)
}

variable "https_allowed_ips" {
  description = "List of IPs allowed for HTTPS (443)"
  type        = list(string)
}