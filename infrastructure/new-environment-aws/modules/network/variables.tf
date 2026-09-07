variable "client_name" {
  type = string
}

variable "custom_tags" {
  type    = map(string)
  default = {}
}

variable "vpc_cidr" {
  type    = list(string)
  default = ["10.0.0.0/16"]
}

variable "app_subnet_prefixes" {
  type    = list(string)
  default = ["10.0.1.0/24"]
}

variable "web_subnet_prefixes" {
  type    = list(string)
  default = ["10.0.2.0/24"]
}

variable "db_subnet_prefixes" {
  type    = list(string)
  default = ["10.0.3.0/24"]
}

# --- Create-vs-existing, same pattern as azure/network.tf's
# create_vnet/create_subnet: a resource+data source pair per toggleable thing,
# reconciled into one "_effective" local downstream callers use (see main.tf).
# create_subnets covers all three (web/app/db) together, not independently. ---

variable "create_vpc" {
  type        = bool
  default     = true
  description = "true = create a new VPC. false = look up existing_vpc_id instead."
}

variable "existing_vpc_id" {
  type        = string
  default     = ""
  description = "VPC ID to use when create_vpc = false"
}

variable "create_subnets" {
  type        = bool
  default     = true
  description = "true = create fresh web/app/db subnets (inside whichever VPC, new or existing). false = look up the three existing_*_subnet_id vars instead, and skip creating any routing (NAT gateway, route tables) for them entirely."
}

variable "existing_web_subnet_id" {
  type    = string
  default = ""
}

variable "existing_app_subnet_id" {
  type    = string
  default = ""
}

variable "existing_db_subnet_id" {
  type    = string
  default = ""
}
