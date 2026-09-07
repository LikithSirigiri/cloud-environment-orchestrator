terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "=4.1.0"
    }
  }
}

# Reads ARM_CLIENT_ID / ARM_CLIENT_SECRET / ARM_TENANT_ID / ARM_SUBSCRIPTION_ID
# from the environment. Backend sets these per-request from whatever creds got
# entered in the Azure Authentication card in the UI - same pattern as
# azure/provider.tf's DR flow.
provider "azurerm" {
  features {}
}
