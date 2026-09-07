// Note: the state *backend* (where the state JSON actually lives) is independent
// of which cloud the resources here belong to. We just reuse the same azurerm
// backend as azure-new-env/backend.tf and DR's backend. getStateKey()/getWorkDir()
// in server.js are already provider-generic, so an AWS deployment for client "acme"/UAT
// simply lands at key "acme/aws/uat/terraform.tfstate" inside the same
// TF_STATE_CONTAINER_NEW_ENV container Azure's New Environment states already use.
// no separate AWS-side state storage needed.
terraform {
  backend "azurerm" {}
}
