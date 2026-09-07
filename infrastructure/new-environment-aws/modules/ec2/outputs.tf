output "private_ips" {
  description = "Map of instance names to their private IPs"
  value       = { for name, inst in aws_instance.server : name => inst.private_ip }
}

output "public_ips" {
  description = "Map of instance names to their public IPs (empty string when none)"
  value       = { for name, inst in aws_instance.server : name => inst.public_ip }
}

output "instance_ids" {
  value = { for name, inst in aws_instance.server : name => inst.id }
}

output "ssh_private_key_pem" {
  description = "The generated private key's PEM (empty when key_pair_mode = \"existing\")"
  value       = var.key_pair_mode == "generate" ? tls_private_key.generated[0].private_key_pem : ""
  sensitive   = true
}
