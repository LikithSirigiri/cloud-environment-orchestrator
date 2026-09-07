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
  description = "Resource groups to create for this client's new environment"
}

variable "vnet_address_space" {
  type        = list(string)
  default     = ["10.0.0.0/16"]
  description = "VNet address space"
}

variable "app_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.1.0/24"]
  description = "App subnet address prefixes"
}

variable "web_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.2.0/24"]
  description = "Web subnet address prefixes"
}

variable "db_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.3.0/24"]
  description = "DB subnet address prefixes"
}

variable "ssh_allowed_ips" {
  type        = list(string)
  description = "List of IPs allowed for SSH (22)"
}

variable "https_allowed_ips" {
  type        = list(string)
  description = "List of IPs allowed for HTTPS (443)"
}

variable "domain" {
  type        = string
  description = "Domain to configure in nginx for the web portals"
}

variable "kong_domain" {
  type        = string
  description = "Kong domain substituted into nginx config"
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

variable "config_repo_path" {
  type        = string
  description = "Absolute path to the vendored app-setup content (3rdparty/microservices/webconfig) that the deploymentfiles module copies onto the VMs"
}

# --- Internal service credentials (generated server-side, never typed by hand) ---

variable "mysqlpassword" {
  type      = string
  sensitive = true
}

variable "mysqlRootPswrd" {
  type      = string
  sensitive = true
}

variable "mongoadminpass" {
  type      = string
  sensitive = true
}

variable "mongolendpassword" {
  type      = string
  sensitive = true
}

variable "mongodatasetpassword" {
  type      = string
  sensitive = true
}

variable "mongobrepassword" {
  type      = string
  sensitive = true
}

variable "mongotemppassword" {
  type      = string
  sensitive = true
}

variable "mongosnspassword" {
  type      = string
  sensitive = true
}

variable "redispswrd" {
  type      = string
  sensitive = true
}

variable "rabbitmqpswd" {
  type      = string
  sensitive = true
}

variable "keycloak_admin_password" {
  type      = string
  sensitive = true
}

# --- Shared infra config (from azure-dr-api/.env, not per-deploy) ---

variable "build_storage_account" {
  type        = string
  description = "Azure Storage account the web VM pulls portal build zips from"
}

variable "build_container_name" {
  type        = string
  description = "Container (in build_storage_account) holding this client+env's build zips, named \"<client>-<env>\""
}

variable "build_container_sas" {
  type        = string
  sensitive   = true
  description = "Read+list-only SAS query string (no leading '?') scoping access to build_container_name"
}

variable "portal_zip_files" {
  type        = map(string)
  description = "Web portal destination folder (e.g. \"access-portal\") -> exact build zip filename to fetch from build_container_name, resolved from an uploaded release manifest"
}

variable "registry_username" {
  type        = string
  description = "Docker registry username"
}

variable "docker_registry_address" {
  type        = string
  description = "Docker registry address"
}

variable "docker_registry_password" {
  type      = string
  sensitive = true
}
