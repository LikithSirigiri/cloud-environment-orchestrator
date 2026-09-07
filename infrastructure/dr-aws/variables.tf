###############################################################################
# REGION CONFIGURATION
###############################################################################

variable "dc_region" {
  description = "AWS region of the primary Data Center (source of snapshots)"
  type        = string
}

variable "dr_region" {
  description = "AWS region of the Disaster Recovery target environment"
  type        = string
}

###############################################################################
# DC INSTANCE DISCOVERY
# set the Name tag value for each server role you want replicated.
# leave a role blank ("") to skip it.
###############################################################################

variable "dc_server_tags" {
  description = "Map of server role keys to their EC2 Name tag values in the DC region"
  type        = map(string)
}

variable "dc_server_ips" {
  description = "Map of server role keys to their existing private IP addresses in the DC region (used for IP replacement after replication)"
  type        = map(string)
}

###############################################################################
# DR NETWORKING
###############################################################################

variable "dr_vpc_name" {
  description = "Name of the DR VPC"
  type        = string
}

variable "dr_vpc_cidr" {
  description = "CIDR block for the DR VPC"
  type        = string
}

variable "dr_public_subnet_cidr" {
  description = "CIDR block for the DR public subnet"
  type        = string
}

variable "dr_private_subnet_cidr" {
  description = "CIDR block for the DR private subnet"
  type        = string
}

variable "dr_availability_zone" {
  description = "Availability zone inside the DR region to deploy resources into"
  type        = string
}

variable "dr_az_count" {
  description = "Number of Availability Zones (AZs) to provision subnets in (1, 2, or 3)"
  type        = number
}


###############################################################################
# INSTANCE CONFIGURATION
###############################################################################

variable "dr_instance_types" {
  description = "Map of server role keys to their EC2 instance types in the DR region (replicated servers automatically copy their DC counterparts, only 'db' is read from here)"
  type        = map(string)
}

###############################################################################
# DATABASE CONFIGURATION
###############################################################################

variable "mongodb_version" {
  description = "MongoDB major version to install on the database servers (e.g. 6.0, 7.0)"
  type        = string
}

variable "db_server_count" {
  description = "Number of MongoDB database server instances to provision (defaults to 2)"
  type        = number
}

variable "ssh_username" {
  description = "SSH username used to connect to the DR instances for post-deployment configuration"
  type        = string
  default     = "ubuntu"
}

variable "local_pem_filename" {
  description = "The filename of the local PEM key inside the project directory used to log into the public web server."
  type        = string
}
