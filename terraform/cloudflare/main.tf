terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# 1. Look up the Zone ID for the provisioned domain
data "cloudflare_zone" "utility_domain" {
  name = var.domain_name
}

# 2. Email Routing Configuration
# Enable Email Routing for the zone
resource "cloudflare_email_routing_settings" "enable" {
  zone_id = data.cloudflare_zone.utility_domain.id
  enabled = "true"
}

# 3. DNS Records for Email Security (SPF, DMARC)
# Cloudflare automatically adds MX and SPF records when Email Routing is enabled via dashboard,
# but we explicitly manage them here for infrastructure as code.

resource "cloudflare_record" "mx_1" {
  zone_id  = data.cloudflare_zone.utility_domain.id
  name     = "@"
  value    = "route1.mx.cloudflare.net"
  type     = "MX"
  priority = 10
}

resource "cloudflare_record" "mx_2" {
  zone_id  = data.cloudflare_zone.utility_domain.id
  name     = "@"
  value    = "route2.mx.cloudflare.net"
  type     = "MX"
  priority = 20
}

resource "cloudflare_record" "mx_3" {
  zone_id  = data.cloudflare_zone.utility_domain.id
  name     = "@"
  value    = "route3.mx.cloudflare.net"
  type     = "MX"
  priority = 30
}

resource "cloudflare_record" "spf" {
  zone_id = data.cloudflare_zone.utility_domain.id
  name    = "@"
  value   = "v=spf1 include:_spf.mx.cloudflare.net -all"
  type    = "TXT"
}

resource "cloudflare_record" "dmarc" {
  zone_id = data.cloudflare_zone.utility_domain.id
  name    = "_dmarc"
  # strict policy: reject emails that fail DMARC to protect domain reputation
  value   = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;"
  type    = "TXT"
}

# 4. Email Worker Route Matcher
# Intercept ALL incoming emails to this domain and send to the Worker
resource "cloudflare_email_routing_catch_all" "send_to_worker" {
  zone_id = data.cloudflare_zone.utility_domain.id
  matcher {
    type = "all"
  }
  action {
    type  = "worker"
    value = [var.email_worker_name]
  }
}
