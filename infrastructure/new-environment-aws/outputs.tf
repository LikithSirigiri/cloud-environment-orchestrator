output "domain" {
  value = var.domain
}

output "all_private_ips" {
  value = module.ec2.private_ips
}

output "all_public_ips" {
  value = module.ec2.public_ips
}

output "ssh_private_key_pem" {
  description = "Generated EC2 SSH private key (empty when key_pair_mode = \"existing\"). Read once by the backend right after Stage 1 succeeds and returned to the UI as a generated secret, never stored elsewhere."
  value       = module.ec2.ssh_private_key_pem
  sensitive   = true
}
