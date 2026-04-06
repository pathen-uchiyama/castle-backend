# ── SNS Topic for Alarm Notifications ────────────────────────────
#
# All CloudWatch alarms route here. Subscribe email/SMS/webhook.
# The same topic feeds n8n webhook for Slack/Discord notifications.

resource "aws_sns_topic" "castle_alerts" {
  name = "${var.project_name}-alerts-${var.environment}"

  tags = {
    Name        = "${var.project_name}-alerts"
    Environment = var.environment
  }
}

# Email subscription for admin
resource "aws_sns_topic_subscription" "admin_email" {
  topic_arn = aws_sns_topic.castle_alerts.arn
  protocol  = "email"
  endpoint  = var.admin_email
}

# Output the ARN for use in monitoring.tf
output "sns_topic_arn" {
  value       = aws_sns_topic.castle_alerts.arn
  description = "SNS topic ARN for alarm notifications"
}
