resource "null_resource" "mongodb_setup" {
  depends_on = [null_resource.ui-deployment]
  # Re-run script when VM is recreated
  triggers = {
    vm_id = var.vm_id
  }

  provisioner "remote-exec" {
    inline = [

      # Disable needrestart prompts (CRITICAL)
      "sudo mkdir -p /etc/needrestart",
      "echo \"\\$nrconf{restart} = 'a';\" | sudo tee /etc/needrestart/needrestart.conf",

      # Wait for dpkg lock
      "while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do echo 'dpkg locked... waiting...'; sleep 3; done",

      # Base packages
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wget gnupg ca-certificates lsb-release",

      # Import MongoDB 8.0 GPG key (modern method)
      "wget -qO - https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-8.0.gpg",

      # Detect Ubuntu codename
      "UBUNTU_CODENAME=$(lsb_release -cs)",

      # Add MongoDB 8.0 repo
      "echo \"deb [signed-by=/usr/share/keyrings/mongodb-8.0.gpg] https://repo.mongodb.org/apt/ubuntu $UBUNTU_CODENAME/mongodb-org/8.0 multiverse\" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list",

      # Update
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org=8.0.16 mongodb-org-server=8.0.16 mongodb-org-shell=8.0.16 mongodb-org-mongos=8.0.16 mongodb-org-tools=8.0.16",


      # Prevent auto-upgrade
      "sudo apt-mark hold mongodb-org mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools",

      # Enable & start
      "sudo systemctl enable mongod",
      "sudo sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf",
      "sudo systemctl start mongod",

      # Verify (no pager)
      "mongod --version | head -n 1",
      "sudo systemctl is-active mongod",


      "sleep 1",
      # Create admin user
      "mongosh --eval 'use admin'",
      "mongosh admin --eval 'db.createUser({user:\"dbadmin\",pwd:\"${var.mongoadminpass}\",roles:[{role:\"root\",db:\"admin\"}]})'",

      # Create DBs
      "mongosh --eval 'db.getSiblingDB(\"ledndb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"snsdb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"templatyzedb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"bredb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"datasetdb\").test.insertOne({created:true})'",
      #"mongosh admin --eval 'db.createUser({user:\"lenddbuse\",pwd:\"${var.mongopassword}\",roles:[{role:\"root\",db:\"admin\"}]})'",

      # Create user for each DB
      "mongosh lenddb --eval 'db.createUser({user:\"lenddbuser\",pwd:\"${var.mongolendpassword}\",roles:[{role:\"readWrite\",db:\"lenddb\"}]})'",
      "mongosh snsdb --eval 'db.createUser({user:\"snsdbuser\",pwd:\"${var.mongosnspassword}\",roles:[{role:\"readWrite\",db:\"snsdb\"}]})'",
      "mongosh templatyzedb --eval 'db.createUser({user:\"templatyzedbuser\",pwd:\"${var.mongotemppassword}\",roles:[{role:\"readWrite\",db:\"templatyzedb\"}]})'",
      "mongosh bredb --eval 'db.createUser({user:\"bredbuser\",pwd:\"${var.mongobrepassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'",
      "mongosh bredb --eval 'db.createUser({user:\"datasetdbuser\",pwd:\"${var.mongodatasetpassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'",

      #enabling security
      "sudo bash -c 'cat >> /etc/mongod.conf <<EOF\nsecurity:\n  authorization: enabled\nEOF'",
      "sudo systemctl enable mongod",
      "sudo systemctl restart mongod",
    ]
    connection {
      type             = "ssh"
      host             = var.db_private_ip
      user             = var.vm_username
      password         = var.vm_password
      port             = 22
      bastion_host     = var.webPIP # Public IP for bastion
      bastion_user     = var.vm_username
      bastion_password = var.vm_password
      bastion_port     = 22
    }
  }
}

resource "null_resource" "copy_to_private" {
  # This triggers the provisioner whenever the source file changes
  depends_on = [null_resource.prepare_folder, null_resource.ui-deployment]
  triggers = {
    always_run = timestamp()
  }

  provisioner "file" {
    source      = "${var.config_repo_path}/3rdparty"
    destination = "/opt/" # Destination on private server

    connection {
      type     = "ssh"
      host     = var.central_private_ip # Private server IP
      user     = var.vm_username
      password = var.vm_password
      port     = 22

      bastion_host     = var.webPIP # Publicly accessible bastion host
      bastion_user     = var.vm_username
      bastion_password = var.vm_password # Password for bastion
      bastion_port     = 22
    }
  }

  provisioner "remote-exec" {
    inline = [
      "sleep 1m",
      "sudo apt-get update && sudo apt-get install unzip && sudo apt-get update",
      "sleep 1m",
      "cd /opt/3rdparty/mysql",
      "sudo sed -i 's|ROOT_PSWRD|${var.mysqlRootPswrd}|g' /opt/3rdparty/mysql/docker-compose.yml",
      "sudo sed -i 's|KEYCLOAK_PSWRD|${var.mysqlpassword}|g' /opt/3rdparty/mysql/docker-compose.yml",
      "sudo docker compose up -d",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"CREATE USER 'keycloak'@'%' IDENTIFIED BY '${var.mysqlpassword}';\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"CREATE DATABASE keycloak CHARACTER SET utf8 COLLATE utf8_unicode_ci;\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"GRANT ALL PRIVILEGES ON keycloak.* TO 'keycloak'@'%';\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"SET group_concat_max_len = 1024*1024;\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"FLUSH PRIVILEGES;\"",
      "sleep 20 ms",
      "cd /opt/3rdparty/keycloak",
      "echo ${var.password} | sudo docker login ${var.address} -u ${var.username} --password-stdin",
      "sudo sed -i 's|KEYCLOAK_PSWRD|${var.mysqlpassword}|g' /opt/3rdparty/keycloak/docker-compose.yml",
      "sudo sed -i 's|CENTRALSERVER-IP|${var.central_private_ip}|g' /opt/3rdparty/keycloak/docker-compose.yml",
      "sudo sed -i 's|DOMAIN|${var.domain}|g' /opt/3rdparty/keycloak/docker-compose.yml",
      "sudo sed -i 's|KEYCLOAK-ADMIN-PASSWORD|${var.keycloak_admin_password}|g' /opt/3rdparty/keycloak/docker-compose.yml",
      "sudo docker compose up -d",
      "sudo sed -i 's|RMQ-PASS|${var.rabbitmqpswd}|g' /opt/3rdparty/rabbitmq/docker-compose.yml",
      "cd /opt/3rdparty/rabbitmq",
      "sudo docker compose up -d",
      "sudo mkdir /opt/3rdparty/redis/redis-data",
      "sudo chown -R deployadmin:deployadmin /opt/3rdparty/redis/redis-data",
      # "sudo chown -R 775 /opt/3rdparty/redis/redis-data",
      "cd /opt/3rdparty/redis/",
      "sudo sed -i 's|REDIS-PASS|${var.redispswrd}|g' /opt/3rdparty/redis/docker-compose.yml",
      "sudo docker compose up -d",
      "sudo docker ps",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"SET group_concat_max_len = 1024*1024;\"",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));\"",
      "sleep 1m",
      "sudo docker exec -i mysql-mysql-1 mysql -uroot -p'${var.mysqlpassword}' -e \"FLUSH PRIVILEGES;\"",
      "sleep 1m"
    ]

    connection {
      type             = "ssh"
      host             = var.central_private_ip
      user             = var.vm_username
      password         = var.vm_password
      port             = 22
      bastion_host     = var.webPIP # 
      bastion_user     = var.vm_username
      bastion_password = var.vm_password
      bastion_port     = 22
    }
  }
}

resource "null_resource" "microservice_deployment" {
  depends_on = [null_resource.copy_to_private, null_resource.prepare_folder_appserver, null_resource.ui-deployment]
  triggers = {
    always_run = timestamp()
  }

  provisioner "file" {
    source      = "${var.config_repo_path}/microservices"
    destination = "/opt/" # Destination on private server

    connection {
      type     = "ssh"
      host     = var.app_private_ip # Private server IP
      user     = var.vm_username
      password = var.vm_password
      port     = 22

      bastion_host     = var.webPIP # Publicly accessible bastion host
      bastion_user     = var.vm_username
      bastion_password = var.vm_password # Password for bastion
      bastion_port     = 22
    }
  }
  provisioner "remote-exec" {
    inline = [
      "cat <<'EOF' > /tmp/install.sh",
      "#!/bin/bash",
      "set -ex", # exit on error, print commands",

      "# Install prerequisites",
      "sudo apt-get update",
      "sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common lsb-release gnupg",

      "# Add Docker GPG key",
      "sudo mkdir -p /etc/apt/keyrings",
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg",
      "# Add Docker repository",
      "echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null",

      "# Install Docker",
      "sudo apt-get update",
      "sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",

      "# Enable Docker service",
      "sudo systemctl enable docker",
      "sudo systemctl start docker",

      "# Verify versions",
      "docker --version",
      "docker compose version",

      "# Install Java",
      "sudo apt-get install -y openjdk-11-jdk",
      "java -version",

      "# Other tools",
      "sudo apt-get install -y sshpass unzip",

      "# Optional: unzip your license file",
      "cd /opt/microservices/access-api && sudo unzip -o licence.zip",
      "ls -lrt",
      "EOF",

      "# Run the script",
      "bash /tmp/install.sh"
    ]
  }
  connection {
    type             = "ssh"
    host             = var.app_private_ip
    user             = var.vm_username
    password         = var.vm_password
    port             = 22
    bastion_host     = var.webPIP # 
    bastion_user     = var.vm_username
    bastion_password = var.vm_password
    bastion_port     = 22
  }

}

resource "null_resource" "prepare_folder" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type             = "ssh"
    host             = var.central_private_ip
    user             = var.vm_username
    password         = var.vm_password
    port             = 22
    bastion_host     = var.webPIP
    bastion_user     = var.vm_username
    bastion_password = var.vm_password
    bastion_port     = 22
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /opt/3rdparty",
      "sudo chown deployadmin:deployadmin /opt/3rdparty"
    ]
  }
}

resource "null_resource" "prepare_folder_appserver" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type             = "ssh"
    host             = var.app_private_ip
    user             = var.vm_username
    password         = var.vm_password
    port             = 22
    bastion_host     = var.webPIP
    bastion_user     = var.vm_username
    bastion_password = var.vm_password
    bastion_port     = 22
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /opt/microservices",
      "sudo mkdir -p /opt/microservices/dataset-api",
      "sudo mkdir -p /opt/microservices/access-api",
      "sudo mkdir -p /opt/microservices/secret-api",
      "sudo mkdir -p /opt/microservices/docstudio-api",
      "sudo mkdir -p /opt/microservices/dochub-api",
      "sudo mkdir -p /opt/microservices/lookup-api",
      "sudo mkdir -p /opt/microservices/admin-api",
      "sudo mkdir -p /opt/microservices/core-api",
      "sudo mkdir -p /opt/microservices/templatyze-api",
      "sudo mkdir -p /opt/microservices/sns-api",
      "sudo mkdir -p /opt/microservices/notification-api",
      "sudo mkdir -p /opt/microservices/decision-api",
      "sudo mkdir -p /opt/microservices/dependency-api",
      "sudo mkdir -p /opt/microservices/adminsupport-api",
      "sudo mkdir -p /opt/microservices/lendsupport-api",
      "sudo mkdir -p /opt/microservices/orgmanage-api",
      "sudo mkdir -p /opt/microservices/api-deployment",
      "sudo mkdir -p /opt/microservices/rabbitmq",
      "sudo mkdir -p /opt/microservices/service",
      "sudo mkdir -p /opt/microservices/gendoc-api",
      "sudo mkdir -p /opt/microservices/gendoc-api/uploads",
      "sudo mkdir -p /opt/microservices/mis-api",
      "sudo mkdir -p /opt/microservices/mis-api/EXTRACTS",
      "sudo chown -R deployadmin:deployadmin /opt/microservices",

      "sudo apt-get update -y",
      "sleep 2",
      "sudo apt-get install -y unzip",
      "sleep 2"
    ]
  }
}

resource "null_resource" "prepare_folder_webapps" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type     = "ssh"
    host     = var.webPIP
    user     = var.vm_username
    password = var.vm_password
    port     = 22
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /opt/webapps",
      "sudo mkdir -p /opt/webapps/user-portal",
      "sudo mkdir -p /opt/webapps/access-portal",
      "sudo mkdir -p /opt/webapps/admin-portal",
      "sudo mkdir -p /opt/webapps/doc-studio",
      "sudo mkdir -p /opt/webapps/dochub",
      "sudo mkdir -p /opt/webapps/lookup",
      "sudo mkdir -p /opt/webapps/support",
      "sudo mkdir -p /opt/webapps/screen-portal",
      "sudo mkdir -p /opt/webapps/SSL",
      "sudo mkdir -p /opt/webapps/SSL/kong",
      "sudo chown -R deployadmin:deployadmin /opt/webapps"
    ]
  }
}
resource "null_resource" "ui-deployment" {
  depends_on = [null_resource.prepare_folder_webapps]
  triggers = {
    force_run = timestamp()
  }
  connection {
    type     = "ssh"
    host     = var.webPIP
    user     = var.vm_username
    password = var.vm_password
    port     = 22
  }

  provisioner "file" {
    source      = "${var.config_repo_path}/webconfig/"
    destination = "/opt/webapps/" # Destination on private server

    connection {
      type     = "ssh"
      host     = var.webPIP # Private server IP
      user     = var.vm_username
      password = var.vm_password
      port     = 22
    }
  }
  provisioner "remote-exec" {

    inline = concat([
      "set -e",
      "echo 'STEP 1: nginx setup'",
      "export DEBIAN_FRONTEND=noninteractive",

      "echo 'Waiting for apt lock...'",
      "while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done",

      "sudo apt-get update -y",
      "sudo apt-get install -y curl gnupg ca-certificates lsb-release unzip",

      "curl -fsSL https://nginx.org/keys/nginx_signing.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/nginx-archive-keyring.gpg",

      "echo \"deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/mainline/$(lsb_release -is | tr '[:upper:]' '[:lower:]') $(lsb_release -cs) nginx\" | sudo tee /etc/apt/sources.list.d/nginx.list",

      "sudo apt-get update -y",

      "sudo apt-get install -y nginx=1.29.1-*",

      "sudo apt-mark hold nginx",

      "sudo systemctl enable nginx",
      "sudo systemctl start nginx",
      #"sudo service nginx status",
      "sudo systemctl status nginx --no-pager",

      "sleep 1",
      "sudo cp /opt/webapps/client-ssl-bundle.zip /opt/webapps/SSL/",
      "cd /opt/webapps/SSL",
      #"sudo rm certificate.crt ca_bundle.crt full.pem",
      "sudo unzip -o client-ssl-bundle.zip",
      "sudo touch full.pem",
      "sudo sh -c 'cat certificate.crt ca_bundle.crt > full.pem'",
      "sudo cp full.pem private.key /opt/webapps/SSL/kong/",
      # 4. Backup and replace nginx config
      "sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx-backup.conf",
      "sudo cp /opt/webapps/nginx.conf /etc/nginx/nginx.conf",

      "echo 'STEP 2: pulling portal builds from Azure Blob'"
      ],
      # 5. pull each portal's exact build zip from the client+env build container
      # and unzip in place. filename comes from portal_zip_files (resolved
      # server-side off the uploaded release manifest), so there's no
      # discovery/guessing at this point. that also means a missing blob fails
      # fast via `curl -f` (we're under `set -e`) instead of quietly leaving an
      # empty file behind.
      flatten([
        for folder, filename in var.portal_zip_files : [
          "sudo mkdir -p /opt/webapps/${folder}",
          "curl -sf -o \"/opt/webapps/${folder}/${filename}\" \"https://${var.build_storage_account}.blob.core.windows.net/${var.build_container_name}/${filename}?${var.build_container_sas}\"",
          "sudo unzip -o \"/opt/webapps/${folder}/${filename}\" -d /opt/webapps/${folder}/"
        ]
      ]),
      [
        "sleep 1",
        # 10. Replace variables in nginx config
        "sudo sed -i 's|CENTRALSERVER-IP|${var.central_private_ip}|g' /etc/nginx/nginx.conf",
        "sudo sed -i 's|APPSERVER-IP|${var.app_private_ip}|g' /etc/nginx/nginx.conf",
        "sudo sed -i 's|KONG-IP|${var.kong_private_ip}|g' /etc/nginx/nginx.conf",
        "sudo sed -i 's|KONG-DOMAIN|${var.kong_domain}|g' /etc/nginx/nginx.conf",
        "sudo sed -i 's|DOMAIN|${var.domain}|g' /etc/nginx/nginx.conf",
        "sudo sed -i 's|DOMAIN|${var.domain}|g' /opt/webapps/*/env.js",
        "sudo sed -i 's|CLIENT|${var.client}|g' /opt/webapps/*/env.js",
        "sudo sed -i 's|REALM|${var.realm}|g' /opt/webapps/*/env.js",
        "sudo sed -i 's|E-ID|${var.realm}|g' /opt/webapps/*/env.js",
        "sudo sed -i 's|REALM|${var.client}|g' /opt/webapps/*/env.js",
        "sudo sed -i 's|CLIENT-ID|${var.client}|g' /opt/webapps/*/env.js",

        # 11. Test and reload nginx
        "sudo nginx -t",
        "sudo systemctl restart nginx",
        "sleep 1"
      ]
    )

  }
}