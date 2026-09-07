output "vpc_id" {
  value = local.vpc_id_effective
}

output "web_subnet_id" {
  value = local.web_subnet_id_effective
}

output "app_subnet_id" {
  value = local.app_subnet_id_effective
}

output "db_subnet_id" {
  value = local.db_subnet_id_effective
}
