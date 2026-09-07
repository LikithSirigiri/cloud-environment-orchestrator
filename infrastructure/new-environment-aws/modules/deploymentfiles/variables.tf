variable "webPIP" {
  type = string
}

variable "central_private_ip" {
  type = string
}

variable "app_private_ip" {
  type = string
}

variable "db_private_ips" {
  type        = map(string)
  description = "DB_SERVER_N key -> private IP, one entry per DB node (always at least 1)"
}

variable "db_instance_ids" {
  type        = map(string)
  description = "DB_SERVER_N key -> EC2 instance id, used only to trigger re-runs when a member is recreated"
}

variable "db_count" {
  type        = number
  description = "1 = standalone MongoDB (today's behavior). >1 = a real PSS replica set across that many nodes."
}

variable "mongo_keyfile" {
  type        = string
  sensitive   = true
  description = "Shared MongoDB replica-set internal-auth keyfile content, only used when db_count > 1"
}

variable "kong_private_ip" {
  type    = string
  default = ""
}

variable "domain" {
  type = string
}

variable "realm" {
  type    = string
  default = "myorg"
}

variable "client" {
  type        = string
  description = "Client name, substituted into portal env.js files"
}

variable "ssh_username" {
  type = string
}

variable "ssh_private_key_pem" {
  type      = string
  sensitive = true
}

variable "portal_zip_files" {
  type        = map(string)
  description = "Web portal destination folder -> exact build zip filename (used only for the local destination path)"
}

variable "portal_zip_urls" {
  type        = map(string)
  sensitive   = true
  description = "Web portal destination folder -> Azure Blob SAS URL for that portal's build zip"
}

variable "microservice_tags" {
  type        = map(string)
  default     = {}
  description = "Microservice name -> Docker image tag, entered manually on the Stage 2 form (the release manifest has no microservice data). Written to the app instance as a reference file; not yet used to actually pull/run anything."
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
  description = "Absolute path to the vendored 3rdparty/microservices/webconfig content this module copies onto the instances"
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
