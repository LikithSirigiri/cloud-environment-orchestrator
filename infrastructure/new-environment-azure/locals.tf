locals {
  # one fixed environment shape per client, no DEV/UAT/PROD split here.
  # sizing matches what the source Jenkins pipeline used for DEV/UAT.
  vm_sizes = {
    db_central_app = "Standard_B4als_v2"
    web_kong       = "Standard_B2s"
  }

  servers = {
    APP_SERVER = {
      vm_size        = local.vm_sizes.db_central_app
      rg_name        = module.subnet.app_rg
      disk_size      = 64
      subnet_id      = module.network.app_subnet_id
      public_ip      = false
      install_docker = true
      install_nginx  = false
      install_mongo  = false
    }
    WEB_SERVER = {
      vm_size        = local.vm_sizes.web_kong
      rg_name        = module.subnet.web_rg
      disk_size      = 32
      subnet_id      = module.network.web_subnet_id
      public_ip      = true
      install_docker = false
      install_nginx  = true
      install_mongo  = false
    }
    kONG_SERVER = {
      vm_size        = local.vm_sizes.web_kong
      rg_name        = module.subnet.app_rg
      disk_size      = 32
      subnet_id      = module.network.app_subnet_id
      public_ip      = false
      install_docker = true
      install_nginx  = false
      install_mongo  = false
    }
    DB_SERVER = {
      vm_size        = local.vm_sizes.db_central_app
      rg_name        = module.subnet.db_rg
      disk_size      = 64
      subnet_id      = module.network.db_subnet_id
      public_ip      = true
      install_docker = false
      install_nginx  = false
      install_mongo  = true
    }
    CENTRAL_SERVER = {
      vm_size        = local.vm_sizes.db_central_app
      rg_name        = module.subnet.app_rg
      disk_size      = 64
      subnet_id      = module.network.app_subnet_id
      public_ip      = false
      install_docker = true
      install_nginx  = false
      install_mongo  = false
    }
  }
}
