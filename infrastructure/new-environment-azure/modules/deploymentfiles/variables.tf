variable "webPIP" {
  type = string
}

variable "central_private_ip" {
  type = string
}

variable "app_private_ip" {
  type = string
}

variable "db_private_ip" {
  type = string
}

variable "kong_private_ip" {
  type = string
}

variable "domain" {
  type = string
}

variable "vm_id" {
  type        = string
  description = "Triggers a re-run of the mongodb_setup provisioner when the DB VM is recreated"
}

variable "realm" {
  type    = string
  default = "myorg"
}

variable "client" {
  type        = string
  description = "Client name, substituted into portal env.js files"
}

variable "vm_password" {
  type      = string
  sensitive = true
}

variable "vm_username" {
  type = string
}

variable "build_storage_account" {
  type        = string
  description = "Azure Storage account the web VM pulls portal build zips from"
}

variable "build_container_name" {
  type        = string
  description = "Container holding this client+env's build zips, also the filename prefix (\"<client>-<env>-<portal>-ui-<version>.zip\")"
}

variable "build_container_sas" {
  type      = string
  sensitive = true
}

variable "portal_zip_files" {
  type        = map(string)
  description = "Web portal destination folder -> exact build zip filename to fetch from build_container_name"
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

variable "mysqlpassword" {
  type      = string
  sensitive = true
}

variable "mysqlRootPswrd" {
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

variable "kong_domain" {
  type = string
}

variable "config_repo_path" {
  type        = string
  description = "Absolute path to the vendored 3rdparty/microservices/webconfig content this module copies onto the VMs"
}

variable "password" {
  type        = string
  sensitive   = true
  description = "Docker registry password"
}

variable "username" {
  type        = string
  description = "Docker registry username"
}

variable "address" {
  type        = string
  description = "Docker registry address"
}
