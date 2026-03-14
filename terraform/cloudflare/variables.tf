variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone.DNS, Zone.Zone, and Zone.EmailRouting permissions"
  type        = string
  sensitive   = true
}

variable "domain_name" {
  description = "The registered utility domain name (e.g. cc-ops-01.com)"
  type        = string
}

variable "email_worker_name" {
  description = "The name of the deployed Cloudflare Email Worker"
  type        = string
  default     = "castle-email-sniffer"
}
