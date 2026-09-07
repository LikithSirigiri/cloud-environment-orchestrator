#!/bin/bash
set -e
exec > >(tee /var/log/mongo-install.log) 2>&1

echo "=== MongoDB Installation Started ==="

# # Variables
# REPLICA_SET_NAME="${REPLICA_SET_NAME}"
# MONGO_ROLE="${MONGO_ROLE}"
# PRIMARY_IP="${PRIMARY_IP}"
# ARBITER_IP="${ARBITER_IP}"
# KEYFILE_CONTENT="${KEYFILE_CONTENT}"

# Variables with defaults
##REPLICA_SET_NAME="$${REPLICA_SET_NAME:-replset}"
##MONGO_ROLE="$${MONGO_ROLE:-primary}"
##PRIMARY_IP="$${PRIMARY_IP:-127.0.0.1}"
##ARBITER_IP="$${ARBITER_IP:-127.0.0.1}"
##KEYFILE_CONTENT="$${KEYFILE_CONTENT}"


echo "=== Starting MongoDB setup at $(date) ==="
##echo "Role: ${MONGO_ROLE}"
##echo "Replica Set Name: ${REPLICA_SET_NAME}"
##echo "Primary IP: ${PRIMARY_IP}"
##echo "Arbiter IP: ${ARBITER_IP}"

# Update package lists
apt-get update

# Install prerequisites
apt-get install -y gnupg curl
# Add MongoDB repository
curl -fsSL https://www.mongodb.org/static/pgp/server-6.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb.gpg
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-6.0.list
# Update package lists again
apt-get update
# Install specific MongoDB version
apt-get install -y mongodb-org=6.0.14 mongodb-org-server=6.0.14 mongodb-org-shell=6.0.14 mongodb-org-mongos=6.0.14 mongodb-org-tools=6.0.14

# Setup directories
mkdir -p /var/lib/mongodb /opt/mongo
chown -R mongodb:mongodb /var/lib/mongodb /opt/mongo
# Create directory for keyfile
mkdir -p /opt/mongo
chown -R mongodb:mongodb /opt/mongo

# Create keyfile (same on all nodes)
echo "${KEYFILE_CONTENT}" | base64 -d > /opt/mongo/mongo-keyfile
chmod 400 /opt/mongo/mongo-keyfile
chown mongodb:mongodb /opt/mongo/mongo-keyfile

# Basic configuration
cat > /etc/mongod.conf <<EOL
storage:
  dbPath: /var/lib/mongodb
  journal:
    enabled: true
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 0.0.0.0
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
security:
  keyFile: /opt/mongo/mongo-keyfile
  authorization: disabled
replication:
  replSetName: mongo-test
EOL

# Update hosts file
#cat >> /etc/hosts <<-EOL
#${PRIMARY_IP} ${REPLICA_SET_NAME}-1
#${ARBITER_IP} ${REPLICA_SET_NAME}-3
#EOL

# Start MongoDB without auth initially
systemctl daemon-reload
systemctl enable mongod
systemctl start mongod

echo "=== MongoDB Installation Completed ==="
sudo cat /var/log/cloud-init-output.log > /home/ubuntu/cloud-init-mongo-install.log