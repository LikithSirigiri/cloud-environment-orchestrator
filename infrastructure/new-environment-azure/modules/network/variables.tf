variable "resource_group_name" {
  description = "The name of the resource group where the VNet and subnet will be created"
  type        = string
}

variable "location" {
  description = "Azure region for the VNet and subnet"
  type        = string
}

variable "vnet_address_space" {
  type        = list(string)
  default     = ["10.0.0.0/16"]
  description = "VNet address space"
}

variable "app_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.1.0/24"]
  description = "Subnet address prefixes"
}

variable "web_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.2.0/24"]
  description = "Subnet address prefixes"
}

variable "db_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.3.0/24"]
  description = "Subnet address prefixes"
}

variable "client_name" {
  type        = string
  description = "Client name"
}

variable "web_nsg_id" {
  type        = string
  description = "Network Security Group ID to associate with the web subnet"
}
