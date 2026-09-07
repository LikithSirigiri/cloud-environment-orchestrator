variable "client_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "custom_tags" {
  type    = map(string)
  default = {}
}

variable "ssh_allowed_ips" {
  type        = list(string)
  description = "List of CIDRs allowed for SSH (22)"
}

variable "https_allowed_ips" {
  type        = list(string)
  description = "List of CIDRs allowed for HTTPS (443)"
}
