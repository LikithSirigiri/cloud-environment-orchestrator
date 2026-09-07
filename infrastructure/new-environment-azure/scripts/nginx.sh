#!/bin/bash
apt-get update
sudo apt install nginx
sudo systemctl start nginx
sudo systemctl enable nginx
sudo systemctl status nginx

echo "nginx is installed "

#sudo apt update
#sudo apt install nginx
#sudo systemctl start nginx
#sudo systemctl enable nginx
#sudo systemctl status nginx
#sudo apt-get install nginx-extras
#sudo apt install zip -y
#sudo apt install unzip