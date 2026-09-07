#!/bin/bash
apt-get update

#Install Required Packages
apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    software-properties-common

# Install OpenJDK 11 (noble version)
apt-get install -y openjdk-11-jdk


#Add Docker’s Official GPG Key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

#Set Up the Docker Repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null


#Install Docker Engine
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io

echo "Installation of Docker-compose v2.23.0"

#Download the Docker Compose Binary
curl -L "https://github.com/docker/compose/releases/download/v2.23.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose


#Apply Executable Permissions
chmod +x /usr/local/bin/docker-compose

echo "Ensure that Docker starts on boot and start the Docker service."
echo "sudo systemctl enable docker"
echo "service start docker"
service enable docker
service start docker

echo "Verifying the docker and docker installation"
docker --version
docker-compose --version
java -version

sudo cat /var/log/cloud-init-output.log > /home/ubuntu/cloud-init.log

#set -e
#echo "=== Starting MySQL deployment ==="

#APP_DIR="/home/deployadmin/"
#MYSQL_DIR="/home/deployadmin/docker-Keycloak-v20/mysql"
#ZIP_PATH="/var/lib/jenkins/workspace/Terraform-Infra_provisioning-RND/modules/deploymentfiles/docker-Keycloak-v20_terraform.zip"
#
#sudo apt-get update -y
#sudo apt-get install -y unzip docker-compose-plugin
#
## Create deployment directory
##sudo mkdir -p $APP_DIR
##sudo chown $USER:$USER $APP_DIR
#
## Unzip the uploaded package (Terraform will upload this)
#unzip -o $ZIP_PATH -d $APP_DIR
#
## Replace IP address if needed
#PRIVATE_IP=$(hostname -I | awk '{print $1}')
##sed -i "s/REPLACE_WITH_IP/${PRIVATE_IP}/g" $APP_DIR/docker-compose.yml || true
#
## Start MySQL container
#cd $MYSQL_DIR
#sudo docker compose up -d
#
## Wait for MySQL to start
#for i in {1..10}; do
#  if sudo docker ps --filter "name=mysql" --filter "health=healthy" | grep -q mysql; then
#    echo "✅ MySQL container is healthy and running!"
#    exit 0
#  fi
#  echo "⏳ Waiting for MySQL to be healthy ($i/10)..."
#  sleep 10
#done
#
#echo "❌ MySQL did not start successfully."
#sudo docker ps

