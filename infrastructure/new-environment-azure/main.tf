module "subnet" {
  source          = "./modules/subnet"
  client_name     = var.client_name
  location        = var.location
  resource_groups = var.resource_groups
}

module "network" {
  source              = "./modules/network"
  resource_group_name = module.subnet.app_rg
  location            = var.location
  vnet_address_space  = var.vnet_address_space
  app_subnet_prefixes = var.app_subnet_prefixes
  web_subnet_prefixes = var.web_subnet_prefixes
  db_subnet_prefixes  = var.db_subnet_prefixes
  client_name         = var.client_name
  web_nsg_id          = module.nsg.nsg_id_https
}

module "nsg" {
  source              = "./modules/nsg"
  resource_group_name = module.subnet.web_rg
  location            = var.location
  ssh_allowed_ips     = var.ssh_allowed_ips
  https_allowed_ips   = var.https_allowed_ips
}

module "vms" {
  source         = "./modules/vm"
  location       = var.location
  admin_username = var.admin_username
  admin_password = var.admin_password
  nsg_id         = module.nsg.nsg_id_https
  servers        = local.servers
  client_name    = var.client_name
}

module "deploymentfilesmovement" {
  depends_on = [module.vms, module.network]
  source     = "./modules/deploymentfiles"

  webPIP             = module.vms.public_ips["WEB_SERVER"]
  app_private_ip     = module.vms.private_ips["APP_SERVER"]
  db_private_ip      = module.vms.private_ips["DB_SERVER"]
  central_private_ip = module.vms.private_ips["CENTRAL_SERVER"]
  kong_private_ip    = module.vms.private_ips["kONG_SERVER"]
  domain             = var.domain
  vm_id              = module.vms.vm_ids["DB_SERVER"]
  vm_password        = var.admin_password
  vm_username        = var.admin_username
  config_repo_path   = var.config_repo_path
  client             = var.client_name

  build_storage_account   = var.build_storage_account
  build_container_name    = var.build_container_name
  build_container_sas     = var.build_container_sas
  portal_zip_files        = var.portal_zip_files
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
