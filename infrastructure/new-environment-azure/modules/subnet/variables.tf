variable "location" {
  type        = string
  description = "Azure region"
}

variable "client_name" {
  type        = string
  description = "Client name"
}

variable "resource_groups" {
  type        = list(string)
  default     = ["web", "app", "db", "security"]
  description = "Resource groups to create"
}
