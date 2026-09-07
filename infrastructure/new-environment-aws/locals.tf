# per-role instance sizing here is user-chosen (var.*_instance_type), not fixed
# like azure-new-env/locals.tf's hardcoded sizing-by-role. that's confirmed as
# scoped to AWS only - Azure's New Environment stays as-is. Kong is optional
# (kong_servers is empty when include_kong = false), and the DB tier is either a
# single standalone node (db_count = 1, today's behavior) or a real multi-node
# PSS MongoDB replica set (db_count > 1). See modules/deploymentfiles/main.tf
# for the two mutually-exclusive setup paths db_count actually picks between.
locals {
  base_servers = {
    APP_SERVER = {
      instance_type     = var.app_instance_type
      subnet_id         = module.network.app_subnet_id
      security_group_id = module.security.private_sg_id
      disk_size         = 64
      public_ip         = false
      install_docker    = true
      install_mongo     = false
    }
    WEB_SERVER = {
      instance_type     = var.web_instance_type
      subnet_id         = module.network.web_subnet_id
      security_group_id = module.security.public_sg_id
      disk_size         = 32
      public_ip         = true
      install_docker    = false
      install_mongo     = false
    }
    CENTRAL_SERVER = {
      instance_type     = var.central_instance_type
      subnet_id         = module.network.app_subnet_id
      security_group_id = module.security.private_sg_id
      disk_size         = 64
      public_ip         = false
      install_docker    = true
      install_mongo     = false
    }
  }

  kong_servers = var.include_kong ? {
    KONG_SERVER = {
      instance_type     = var.kong_instance_type
      subnet_id         = module.network.app_subnet_id
      security_group_id = module.security.private_sg_id
      disk_size         = 32
      public_ip         = false
      install_docker    = true
      install_mongo     = false
    }
  } : {}

  db_servers = {
    for i in range(var.db_count) : "DB_SERVER_${i + 1}" => {
      instance_type     = var.db_instance_type
      subnet_id         = module.network.db_subnet_id
      security_group_id = module.security.private_sg_id
      disk_size         = 64
      public_ip         = false
      install_docker    = false
      install_mongo     = false # mongo install is handled by deploymentfiles' own resources, not user_data, once a replica set is in play
    }
  }

  servers = merge(local.base_servers, local.kong_servers, local.db_servers)
}
