variable "region" {
  type        = string
  description = "AWS region"
}

variable "client_name" {
  type        = string
  description = "Client name"
}

// user-supplied tags, applied to every taggable resource this module creates
// (VPC/subnets/route tables/NAT/EIP/IGW, security groups, EC2 instances).
// merged in via merge(var.custom_tags, {resource-specific tags}) everywhere,
// so a custom tag can never clobber a required one (Name, ManagedBy, etc.).
variable "custom_tags" {
  type        = map(string)
  default     = {}
  description = "Extra tags to apply to every resource this module creates, in addition to its own required tags"
}

variable "vpc_cidr" {
  type        = list(string)
  default     = ["10.0.0.0/16"]
  description = "VPC CIDR block"
}

variable "app_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.1.0/24"]
  description = "App (private) subnet CIDR"
}

variable "web_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.2.0/24"]
  description = "Web (public) subnet CIDR"
}

variable "db_subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.3.0/24"]
  description = "DB (private) subnet CIDR"
}

# --- Create-vs-existing VPC/subnets, see modules/network for the actual logic.
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
  description = "true = create fresh web/app/db subnets. false = look up the three existing_*_subnet_id vars instead."
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

variable "ssh_allowed_ips" {
  type        = list(string)
  description = "List of CIDRs allowed for SSH (22)"
}

variable "https_allowed_ips" {
  type        = list(string)
  description = "List of CIDRs allowed for HTTPS (443)"
}

variable "domain" {
  type        = string
  description = "Domain to configure in nginx for the web portals"
}

variable "kong_domain" {
  type        = string
  description = "Kong domain substituted into nginx config"
}

variable "ssh_username" {
  type        = string
  default     = "ubuntu"
  description = "SSH username on the EC2 instances (Ubuntu AMI default)"
}

# --- EC2 key pair: generate a new one, or use one that already exists in this AWS account ---

variable "key_pair_mode" {
  type        = string
  description = "\"generate\" to have Terraform create and register a new key pair, \"existing\" to reference one already in this AWS account/region"
  validation {
    condition     = contains(["generate", "existing"], var.key_pair_mode)
    error_message = "key_pair_mode must be \"generate\" or \"existing\"."
  }
}

variable "existing_key_pair_name" {
  type        = string
  default     = ""
  description = "Name of an existing AWS key pair to use when key_pair_mode = \"existing\""
}

variable "config_repo_path" {
  type        = string
  description = "Absolute path to the vendored app-setup content (3rdparty/microservices/webconfig) that the deploymentfiles module copies onto the instances"
}

# --- Per-role topology: instance sizing, optional Kong, DB node count ---

variable "web_instance_type" {
  type        = string
  description = "EC2 instance type for the web instance"
}

variable "app_instance_type" {
  type        = string
  description = "EC2 instance type for the app instance"
}

variable "central_instance_type" {
  type        = string
  description = "EC2 instance type for the central instance"
}

variable "kong_instance_type" {
  type        = string
  default     = "t3.small"
  description = "EC2 instance type for the Kong instance (unused when include_kong = false)"
}

variable "db_instance_type" {
  type        = string
  description = "EC2 instance type for each DB instance"
}

variable "include_kong" {
  type        = bool
  default     = true
  description = "Whether to provision a Kong instance at all"
}

variable "db_count" {
  type        = number
  default     = 1
  description = "1 = a plain standalone MongoDB (today's behavior). 3 = a real PSS MongoDB replica set across 3 nodes. No other value is offered from the form."
  validation {
    condition     = contains([1, 3], var.db_count)
    error_message = "db_count must be 1 or 3."
  }
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

// build artifacts live in the same Azure Storage account Terraform state does,
// not a separate AWS S3 bucket. These two vars are actually unused by any
// resource in this module (portal_zip_urls below is already a map of complete,
// ready-to-curl URLs) - kept around only so the deployment's tfvars.json
// records where the builds came from.
variable "build_storage_account" {
  type        = string
  description = "Azure Storage account the web instance pulls portal build zips from"
}

variable "build_container_name" {
  type        = string
  description = "Container (in build_storage_account) holding this client+env's build zips, \"<client>-<env>\""
}

variable "portal_zip_files" {
  type        = map(string)
  description = "Web portal destination folder (e.g. \"access-portal\") -> exact build zip filename, resolved from an uploaded release manifest"
}

variable "portal_zip_urls" {
  type        = map(string)
  sensitive   = true
  description = "Web portal destination folder -> Azure Blob SAS URL for portal_zip_files' filename, generated server-side, same mechanism the Azure New Environment flow already uses"
}

// manual fallback for microservice name -> Docker image tag. The release
// manifest only ever covers web portal versions, never these. For now it just
// gets written to the app instance as a JSON file (see deploymentfiles'
// microservice_tags resource) - not yet wired into an actual docker-compose
// pull/run step, since there's no microservice deployment today either.
variable "microservice_tags" {
  type        = map(string)
  default     = {}
  description = "Microservice name -> Docker image tag, entered manually on the Stage 2 form"
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
