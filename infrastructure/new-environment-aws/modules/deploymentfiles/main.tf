# This is basically a near-verbatim port of azure-new-env/modules/deploymentfiles/main.tf.
# Same SSH remote-exec/file provisioner shape, bastion through the web instance's
# public IP, and the SAME Azure Blob Storage account for build artifacts (build
# files and Terraform state both live there no matter which cloud a deployment's
# VMs end up on - see var.portal_zip_urls, generated server-side exactly like the
# Azure route does for its own web VM). The one real difference from the Azure
# version: connections authenticate with ssh_private_key_pem instead of a password.

# db_count = 1 means plain standalone Mongo (mongodb_setup_standalone - today's
# exact script). db_count > 1 is a real PSS replica set, all data-bearing, going
# through mongodb_install_replica -> mongodb_replica_init -> mongodb_enable_auth ->
# mongodb_replica_confirm. Double checked with the team: these aren't interchangeable,
# a single node has to stay standalone, not a 1-member "replica set."
locals {
  db_sorted_keys = sort(keys(var.db_private_ips))
  db_primary_key = local.db_sorted_keys[0]

  # e.g. {_id: 0, host: "10.0.3.10:27017"}, {_id: 1, host: "10.0.3.11:27017"}, ...
  replica_set_members_js = join(", ", [
    for idx, k in local.db_sorted_keys : "{_id: ${idx}, host: \"${var.db_private_ips[k]}:27017\"}"
  ])
}

resource "null_resource" "mongodb_setup_standalone" {
  count      = var.db_count == 1 ? 1 : 0
  depends_on = [null_resource.ui-deployment]
  triggers = {
    instance_id = var.db_instance_ids[local.db_primary_key]
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /etc/needrestart",
      "echo \"\\$nrconf{restart} = 'a';\" | sudo tee /etc/needrestart/needrestart.conf",

      "while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do echo 'dpkg locked... waiting...'; sleep 3; done",

      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wget gnupg ca-certificates lsb-release",

      "wget -qO - https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-8.0.gpg",

      "UBUNTU_CODENAME=$(lsb_release -cs)",

      "echo \"deb [signed-by=/usr/share/keyrings/mongodb-8.0.gpg] https://repo.mongodb.org/apt/ubuntu $UBUNTU_CODENAME/mongodb-org/8.0 multiverse\" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list",

      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org=8.0.16 mongodb-org-server=8.0.16 mongodb-org-shell=8.0.16 mongodb-org-mongos=8.0.16 mongodb-org-tools=8.0.16",

      "sudo apt-mark hold mongodb-org mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools",

      "sudo systemctl enable mongod",
      "sudo sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf",
      "sudo systemctl start mongod",

      "mongod --version | head -n 1",
      "sudo systemctl is-active mongod",

      "sleep 1",
      "mongosh --eval 'use admin'",
      "mongosh admin --eval 'db.createUser({user:\"dbadmin\",pwd:\"${var.mongoadminpass}\",roles:[{role:\"root\",db:\"admin\"}]})'",

      "mongosh --eval 'db.getSiblingDB(\"ledndb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"snsdb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"templatyzedb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"bredb\").test.insertOne({created:true})'",
      "mongosh --eval 'db.getSiblingDB(\"datasetdb\").test.insertOne({created:true})'",

      "mongosh lenddb --eval 'db.createUser({user:\"lenddbuser\",pwd:\"${var.mongolendpassword}\",roles:[{role:\"readWrite\",db:\"lenddb\"}]})'",
      "mongosh snsdb --eval 'db.createUser({user:\"snsdbuser\",pwd:\"${var.mongosnspassword}\",roles:[{role:\"readWrite\",db:\"snsdb\"}]})'",
      "mongosh templatyzedb --eval 'db.createUser({user:\"templatyzedbuser\",pwd:\"${var.mongotemppassword}\",roles:[{role:\"readWrite\",db:\"templatyzedb\"}]})'",
      "mongosh bredb --eval 'db.createUser({user:\"bredbuser\",pwd:\"${var.mongobrepassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'",
      "mongosh bredb --eval 'db.createUser({user:\"datasetdbuser\",pwd:\"${var.mongodatasetpassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'",

      "sudo bash -c 'cat >> /etc/mongod.conf <<EOF\nsecurity:\n  authorization: enabled\nEOF'",
      "sudo systemctl enable mongod",
      "sudo systemctl restart mongod",
    ]
    connection {
      type                = "ssh"
      host                = var.db_private_ips[local.db_primary_key]
      user                = var.ssh_username
      private_key         = var.ssh_private_key_pem
      port                = 22
      bastion_host        = var.webPIP
      bastion_user        = var.ssh_username
      bastion_private_key = var.ssh_private_key_pem
      bastion_port        = 22
    }
  }
}

# --- PSS replica set path (db_count > 1) ---

# Step 1: install MongoDB and configure replSetName on every member, no
# keyfile/auth yet. unauthenticated replication is a normal, valid Mongo setup,
# and it's exactly what lets rs.initiate() run next without an auth chicken-and-egg problem.
resource "null_resource" "mongodb_install_replica" {
  for_each   = var.db_count > 1 ? var.db_private_ips : {}
  depends_on = [null_resource.ui-deployment]
  triggers = {
    instance_id = var.db_instance_ids[each.key]
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /etc/needrestart",
      "echo \"\\$nrconf{restart} = 'a';\" | sudo tee /etc/needrestart/needrestart.conf",
      "while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do echo 'dpkg locked... waiting...'; sleep 3; done",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wget gnupg ca-certificates lsb-release",
      "wget -qO - https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-8.0.gpg",
      "UBUNTU_CODENAME=$(lsb_release -cs)",
      "echo \"deb [signed-by=/usr/share/keyrings/mongodb-8.0.gpg] https://repo.mongodb.org/apt/ubuntu $UBUNTU_CODENAME/mongodb-org/8.0 multiverse\" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org=8.0.16 mongodb-org-server=8.0.16 mongodb-org-shell=8.0.16 mongodb-org-mongos=8.0.16 mongodb-org-tools=8.0.16",
      "sudo apt-mark hold mongodb-org mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools",

      "sudo sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf",
      "sudo bash -c 'cat >> /etc/mongod.conf <<EOF\nreplication:\n  replSetName: rs0\nEOF'",

      "sudo systemctl enable mongod",
      "sudo systemctl restart mongod",
      "mongod --version | head -n 1",
      "sudo systemctl is-active mongod"
    ]
    connection {
      type                = "ssh"
      host                = each.value
      user                = var.ssh_username
      private_key         = var.ssh_private_key_pem
      port                = 22
      bastion_host        = var.webPIP
      bastion_user        = var.ssh_username
      bastion_private_key = var.ssh_private_key_pem
      bastion_port        = 22
    }
  }
}

# Step 2: initiate the replica set from the primary candidate, wait for the
# election, then create the admin + per-service users. still unauthenticated at
# this point, so it works fine against whichever member ends up PRIMARY.
resource "null_resource" "mongodb_replica_init" {
  count      = var.db_count > 1 ? 1 : 0
  depends_on = [null_resource.mongodb_install_replica]
  triggers = {
    members = join(",", values(var.db_private_ips))
  }

  connection {
    type                = "ssh"
    host                = var.db_private_ips[local.db_primary_key]
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }

  provisioner "remote-exec" {
    inline = concat([
      "set -e",
      "echo '=== Initiating MongoDB replica set rs0 ==='",
      "mongosh --eval 'rs.initiate({_id: \"rs0\", members: [${local.replica_set_members_js}]})'",
      replace(<<-EOT
        echo 'Waiting for a PRIMARY to be elected...'
        for i in $(seq 1 30); do
          STATE=$(mongosh --quiet --eval 'rs.isMaster().ismaster' 2>/dev/null | tail -n1)
          if [ "$STATE" = "true" ]; then echo '✔ Primary elected.'; break; fi
          echo "  Waiting... ($i/30)"
          sleep 2
        done
      EOT
      , "\r", "")
      ],
      [
        "mongosh --eval 'use admin'",
        "mongosh admin --eval 'db.createUser({user:\"dbadmin\",pwd:\"${var.mongoadminpass}\",roles:[{role:\"root\",db:\"admin\"}]})'",
        "mongosh --eval 'db.getSiblingDB(\"ledndb\").test.insertOne({created:true})'",
        "mongosh --eval 'db.getSiblingDB(\"snsdb\").test.insertOne({created:true})'",
        "mongosh --eval 'db.getSiblingDB(\"templatyzedb\").test.insertOne({created:true})'",
        "mongosh --eval 'db.getSiblingDB(\"bredb\").test.insertOne({created:true})'",
        "mongosh --eval 'db.getSiblingDB(\"datasetdb\").test.insertOne({created:true})'",
        "mongosh lenddb --eval 'db.createUser({user:\"lenddbuser\",pwd:\"${var.mongolendpassword}\",roles:[{role:\"readWrite\",db:\"lenddb\"}]})'",
        "mongosh snsdb --eval 'db.createUser({user:\"snsdbuser\",pwd:\"${var.mongosnspassword}\",roles:[{role:\"readWrite\",db:\"snsdb\"}]})'",
        "mongosh templatyzedb --eval 'db.createUser({user:\"templatyzedbuser\",pwd:\"${var.mongotemppassword}\",roles:[{role:\"readWrite\",db:\"templatyzedb\"}]})'",
        "mongosh bredb --eval 'db.createUser({user:\"bredbuser\",pwd:\"${var.mongobrepassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'",
        "mongosh bredb --eval 'db.createUser({user:\"datasetdbuser\",pwd:\"${var.mongodatasetpassword}\",roles:[{role:\"readWrite\",db:\"bredb\"}]})'"
      ]
    )
  }
}

# Step 3: every service user exists now, so roll auth out to every member -
# write the shared keyfile, flip on security.authorization, restart mongod.
resource "null_resource" "mongodb_enable_auth" {
  for_each   = var.db_count > 1 ? var.db_private_ips : {}
  depends_on = [null_resource.mongodb_replica_init]
  triggers = {
    instance_id = var.db_instance_ids[each.key]
  }

  connection {
    type                = "ssh"
    host                = each.value
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }

  provisioner "remote-exec" {
    inline = [
      "echo '${var.mongo_keyfile}' | sudo tee /etc/mongo-keyfile > /dev/null",
      "sudo chmod 400 /etc/mongo-keyfile",
      "sudo chown mongodb:mongodb /etc/mongo-keyfile",
      "sudo bash -c 'cat >> /etc/mongod.conf <<EOF\nsecurity:\n  keyFile: /etc/mongo-keyfile\n  authorization: enabled\nEOF'",
      "sudo systemctl restart mongod"
    ]
  }
}

# Step 4: confirm the set re-elects and comes back healthy once every member is
# running with auth enabled.
resource "null_resource" "mongodb_replica_confirm" {
  count      = var.db_count > 1 ? 1 : 0
  depends_on = [null_resource.mongodb_enable_auth]
  triggers = {
    members = join(",", values(var.db_private_ips))
  }

  connection {
    type                = "ssh"
    host                = var.db_private_ips[local.db_primary_key]
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }

  provisioner "remote-exec" {
    inline = [
      "sleep 5",
      replace(<<-EOT
        echo 'Confirming replica set health with auth enabled...'
        for i in $(seq 1 30); do
          OK=$(mongosh -u dbadmin -p '${var.mongoadminpass}' --authenticationDatabase admin --quiet --eval 'rs.status().ok' 2>/dev/null | tail -n1)
          if [ "$OK" = "1" ]; then echo '✔ Replica set healthy.'; exit 0; fi
          echo "  Waiting... ($i/30)"
          sleep 2
        done
        echo '❌ Replica set did not report healthy after enabling auth.'
        exit 1
      EOT
      , "\r", "")
    ]
  }
}

resource "null_resource" "copy_to_private" {
  depends_on = [null_resource.prepare_folder, null_resource.ui-deployment]
  triggers = {
    always_run = timestamp()
  }

  provisioner "file" {
    source      = "${var.config_repo_path}/3rdparty"
    destination = "/opt/"

    connection {
      type                = "ssh"
      host                = var.central_private_ip
      user                = var.ssh_username
      private_key         = var.ssh_private_key_pem
      port                = 22
      bastion_host        = var.webPIP
      bastion_user        = var.ssh_username
      bastion_private_key = var.ssh_private_key_pem
      bastion_port        = 22
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
      "sudo chown -R ${var.ssh_username}:${var.ssh_username} /opt/3rdparty/redis/redis-data",
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
      type                = "ssh"
      host                = var.central_private_ip
      user                = var.ssh_username
      private_key         = var.ssh_private_key_pem
      port                = 22
      bastion_host        = var.webPIP
      bastion_user        = var.ssh_username
      bastion_private_key = var.ssh_private_key_pem
      bastion_port        = 22
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
    destination = "/opt/"

    connection {
      type                = "ssh"
      host                = var.app_private_ip
      user                = var.ssh_username
      private_key         = var.ssh_private_key_pem
      port                = 22
      bastion_host        = var.webPIP
      bastion_user        = var.ssh_username
      bastion_private_key = var.ssh_private_key_pem
      bastion_port        = 22
    }
  }
  provisioner "remote-exec" {
    inline = [
      "cat <<'EOF' > /tmp/install.sh",
      "#!/bin/bash",
      "set -ex",

      "# Install prerequisites",
      "sudo apt-get update",
      "sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common lsb-release gnupg",

      "# Add Docker GPG key",
      "sudo mkdir -p /etc/apt/keyrings",
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg",
      "echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null",

      "sudo apt-get update",
      "sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",

      "sudo systemctl enable docker",
      "sudo systemctl start docker",

      "docker --version",
      "docker compose version",

      "sudo apt-get install -y openjdk-11-jdk",
      "java -version",

      "sudo apt-get install -y sshpass unzip",

      "cd /opt/microservices/access-api && sudo unzip -o licence.zip",
      "ls -lrt",
      "EOF",

      "bash /tmp/install.sh"
    ]
  }
  connection {
    type                = "ssh"
    host                = var.app_private_ip
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }
}

resource "null_resource" "prepare_folder" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type                = "ssh"
    host                = var.central_private_ip
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mkdir -p /opt/3rdparty",
      "sudo chown ${var.ssh_username}:${var.ssh_username} /opt/3rdparty"
    ]
  }
}

resource "null_resource" "prepare_folder_appserver" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type                = "ssh"
    host                = var.app_private_ip
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
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
      "sudo chown -R ${var.ssh_username}:${var.ssh_username} /opt/microservices",

      "sudo apt-get update -y",
      "sleep 2",
      "sudo apt-get install -y unzip",
      "sleep 2"
    ]
  }
}

# manual fallback for microservice name -> Docker image tag (release manifest
# only ever covers web portal versions). this just writes a plain reference
# file for now - nothing in this module reads it back or pulls/runs any
# microservice image yet, same partial state as before this resource existed.
# whoever wires up the actual microservice docker-compose deployment gets this
# to read from.
resource "null_resource" "microservice_tags_file" {
  count      = length(var.microservice_tags) > 0 ? 1 : 0
  depends_on = [null_resource.prepare_folder_appserver]
  triggers = {
    tags_json = jsonencode(var.microservice_tags)
  }

  connection {
    type                = "ssh"
    host                = var.app_private_ip
    user                = var.ssh_username
    private_key         = var.ssh_private_key_pem
    port                = 22
    bastion_host        = var.webPIP
    bastion_user        = var.ssh_username
    bastion_private_key = var.ssh_private_key_pem
    bastion_port        = 22
  }

  provisioner "remote-exec" {
    inline = [
      "echo '${jsonencode(var.microservice_tags)}' | sudo tee /opt/microservices/image-tags.json > /dev/null"
    ]
  }
}

resource "null_resource" "prepare_folder_webapps" {
  triggers = {
    force_run = timestamp()
  }
  connection {
    type        = "ssh"
    host        = var.webPIP
    user        = var.ssh_username
    private_key = var.ssh_private_key_pem
    port        = 22
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
      "sudo chown -R ${var.ssh_username}:${var.ssh_username} /opt/webapps"
    ]
  }
}

resource "null_resource" "ui-deployment" {
  depends_on = [null_resource.prepare_folder_webapps]
  triggers = {
    force_run = timestamp()
  }
  connection {
    type        = "ssh"
    host        = var.webPIP
    user        = var.ssh_username
    private_key = var.ssh_private_key_pem
    port        = 22
  }

  provisioner "file" {
    source      = "${var.config_repo_path}/webconfig/"
    destination = "/opt/webapps/"

    connection {
      type        = "ssh"
      host        = var.webPIP
      user        = var.ssh_username
      private_key = var.ssh_private_key_pem
      port        = 22
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
      "sudo systemctl status nginx --no-pager",

      "sleep 1",
      "sudo cp /opt/webapps/client-ssl-bundle.zip /opt/webapps/SSL/",
      "cd /opt/webapps/SSL",
      "sudo unzip -o client-ssl-bundle.zip",
      "sudo touch full.pem",
      "sudo sh -c 'cat certificate.crt ca_bundle.crt > full.pem'",
      "sudo cp full.pem private.key /opt/webapps/SSL/kong/",
      "sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx-backup.conf",
      "sudo cp /opt/webapps/nginx.conf /etc/nginx/nginx.conf",

      "echo 'STEP 2: pulling portal builds from Azure Blob'"
      ],
      # pull each portal's exact build zip from its Azure Blob SAS URL (generated
      # server-side, one per portal, see portal_zip_urls) and unzip in place.
      # no discovery/guessing involved - a missing blob fails immediately via
      # `curl -f` (we're under `set -e`) instead of quietly leaving an empty file.
      flatten([
        for folder, filename in var.portal_zip_files : [
          "sudo mkdir -p /opt/webapps/${folder}",
          "curl -sf -o \"/opt/webapps/${folder}/${filename}\" \"${var.portal_zip_urls[folder]}\"",
          "sudo unzip -o \"/opt/webapps/${folder}/${filename}\" -d /opt/webapps/${folder}/"
        ]
      ]),
      [
        "sleep 1",
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

        "sudo nginx -t",
        "sudo systemctl restart nginx",
        "sleep 1"
      ]
    )

  }
}
