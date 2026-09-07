#!/bin/bash
sudo apt-get update

#Install Required Packages
sudo apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    software-properties-common

# Install OpenJDK 11 (noble version)
sudo apt-get install -y openjdk-11-jdk


#Add Docker’s Official GPG Key
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

#Set Up the Docker Repository
sudo echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null


#Install Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io

echo "Installation of Docker-compose v2.23.0"

#Download the Docker Compose Binary
sudo curl -L "https://github.com/docker/compose/releases/download/v2.23.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose


#Apply Executable Permissions
sudo chmod +x /usr/local/bin/docker-compose

echo "Ensure that Docker starts on boot and start the Docker service."
echo "sudo systemctl enable docker"
echo "service start docker"
sudo service enable docker
sudo service start docker

echo "Verifying the docker and docker installation"
sudo docker --version
sudo docker-compose --version
java -version

sudo cat /var/log/cloud-init-output.log > /home/ubuntu/cloud-init.log

sudo apt-get update
sudo apt-get install -y sshpass
