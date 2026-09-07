# generate an SSH key pair when ssh_key auth is selected
resource "tls_private_key" "vm_ssh" {
  count     = var.vm_authentication_type == "ssh_key" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

# save the private key locally so the user can actually connect
resource "local_sensitive_file" "pem_file" {
  count           = var.vm_authentication_type == "ssh_key" ? 1 : 0
  content         = tls_private_key.vm_ssh[0].private_key_pem
  filename        = "${path.module}/${var.vm_ssh_key_name}.pem"
  file_permission = "0600"
}
