# ── VPC Data Sources ─────────────────────────────────────────────
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ── Application Load Balancer (ALB) ──────────────────────────────
resource "aws_lb" "castle_alb" {
  name               = "${var.project_name}-alb-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = data.aws_subnets.default.ids

  enable_deletion_protection = false

  tags = {
    Name        = "${var.project_name}-alb"
    Environment = var.environment
  }
}

# ── Target Group ─────────────────────────────────────────────────
resource "aws_lb_target_group" "castle_tg" {
  name     = "${var.project_name}-tg-${var.environment}"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  # Health check to ensure instances are reachable
  health_check {
    enabled             = true
    path                = "/api"  # Basic health check endpoint
    port                = "traffic-port"
    healthy_threshold   = 3
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200-404" # 404 is acceptable for /api (as it's an API root giving 404)
  }
}

# ── Listener ─────────────────────────────────────────────────────
resource "aws_lb_listener" "castle_listener_http" {
  load_balancer_arn = aws_lb.castle_alb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.castle_tg.arn
  }
}

# Output the ALB DNS Name
output "alb_dns_name" {
  description = "The DNS Name of the Application Load Balancer"
  value       = aws_lb.castle_alb.dns_name
}

# ── HTTPS Listener ─────────────────────────────────────────────────
resource "aws_lb_listener" "castle_listener_https" {
  load_balancer_arn = aws_lb.castle_alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = "arn:aws:acm:us-east-1:943273444176:certificate/c4801563-648d-47a9-8906-09766da2c10f"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.castle_tg.arn
  }
}
