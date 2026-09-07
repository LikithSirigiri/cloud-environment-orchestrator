module "network" {
  source                 = "./modules/network"
  client_name            = var.client_name
  custom_tags            = var.custom_tags
  vpc_cidr               = var.vpc_cidr
  app_subnet_prefixes    = var.app_subnet_prefixes
  web_subnet_prefixes    = var.web_subnet_prefixes
  db_subnet_prefixes     = var.db_subnet_prefixes
  create_vpc             = var.create_vpc
  existing_vpc_id        = var.existing_vpc_id
  create_subnets         = var.create_subnets
  existing_web_subnet_id = var.existing_web_subnet_id
  existing_app_subnet_id = var.existing_app_subnet_id
  existing_db_subnet_id  = var.existing_db_subnet_id
}

module "security" {
  source            = "./modules/security"
  client_name       = var.client_name
  custom_tags       = var.custom_tags
  vpc_id            = module.network.vpc_id
  ssh_allowed_ips   = var.ssh_allowed_ips
  https_allowed_ips = var.https_allowed_ips
}

module "ec2" {
  source                 = "./modules/ec2"
  client_name            = var.client_name
  custom_tags            = var.custom_tags
  ssh_username           = var.ssh_username
  key_pair_mode          = var.key_pair_mode
  existing_key_pair_name = var.existing_key_pair_name
  servers                = local.servers
}

locals {
  # DB_SERVER_1..N, however many db_count actually created. The deploymentfiles
  # module works out which one is the initial primary on its own (sort(keys(...))[0]).
  db_private_ips  = { for k, v in module.ec2.private_ips : k => v if startswith(k, "DB_SERVER") }
  db_instance_ids = { for k, v in module.ec2.instance_ids : k => v if startswith(k, "DB_SERVER") }
}

# shared MongoDB replica-set internal-auth keyfile. Only meaningful when
# db_count > 1 (see modules/deploymentfiles for the standalone-vs-replica-set
# split). Kept alphanumeric only so it's safe to embed in a single-quoted bash string.
resource "random_password" "mongo_keyfile" {
  length  = 756
  special = false
}

module "deploymentfilesmovement" {
  depends_on = [module.ec2, module.network]
  source     = "./modules/deploymentfiles"

  webPIP             = module.ec2.public_ips["WEB_SERVER"]
  app_private_ip     = module.ec2.private_ips["APP_SERVER"]
  central_private_ip = module.ec2.private_ips["CENTRAL_SERVER"]
  # Kong is optional, so try() falls back to "" when include_kong = false -
  # module.ec2.private_ips just won't have a "KONG_SERVER" key in that case.
  kong_private_ip     = try(module.ec2.private_ips["KONG_SERVER"], "")
  domain              = var.domain
  db_private_ips      = local.db_private_ips
  db_instance_ids     = local.db_instance_ids
  db_count            = var.db_count
  mongo_keyfile       = random_password.mongo_keyfile.result
  ssh_username        = var.ssh_username
  ssh_private_key_pem = module.ec2.ssh_private_key_pem
  config_repo_path    = var.config_repo_path
  client              = var.client_name

  # don't need build_storage_account/build_container_name here since portal_zip_urls
  # is already a map of complete, ready-to-curl Azure Blob SAS URLs.
  portal_zip_files  = var.portal_zip_files
  portal_zip_urls   = var.portal_zip_urls
  microservice_tags = var.microservice_tags

  mysqlRootPswrd          = var.mysqlRootPswrd
  mysqlpassword           = var.mysqlpassword
  mongolendpassword       = var.mongolendpassword
  mongodatasetpassword    = var.mongodatasetpassword
  mongobrepassword        = var.mongobrepassword
  mongotemppassword       = var.mongotemppassword
  mongosnspassword        = var.mongosnspassword
  mongoadminpass          = var.mongoadminpass
  redispswrd              = var.redispswrd
  rabbitmqpswd            = var.rabbitmqpswd
  keycloak_admin_password = var.keycloak_admin_password
  kong_domain             = var.kong_domain

  address  = var.docker_registry_address
  username = var.registry_username
  password = var.docker_registry_password
}
