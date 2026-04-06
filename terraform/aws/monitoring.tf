# ── CloudWatch Dashboard ─────────────────────────────────────────
#
# Castle Backend Monitoring — Production Observability
# Panels: API latency, error rate, queue depth, tier split, LLM usage
#
# NOTE: This uses CloudWatch instead of Grafana/Prometheus since we're
# already on AWS. Same signal coverage, zero additional infra to manage.

resource "aws_cloudwatch_dashboard" "castle_dashboard" {
  dashboard_name = "${var.project_name}-production"

  dashboard_body = jsonencode({
    widgets = [
      # ── Row 1: System Health ──────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "🏰 API Latency (p50 / p95 / p99)"
          metrics = [
            ["CastleBackend", "ApiLatencyMs", "Endpoint", "ALL", { stat = "p50", label = "p50" }],
            ["CastleBackend", "ApiLatencyMs", "Endpoint", "ALL", { stat = "p95", label = "p95" }],
            ["CastleBackend", "ApiLatencyMs", "Endpoint", "ALL", { stat = "p99", label = "p99" }],
          ]
          view    = "timeSeries"
          stacked = false
          period  = 60
          region  = var.aws_region
          yAxis = {
            left = { min = 0, label = "ms" }
          }
          annotations = {
            horizontal = [
              { value = 200, label = "Target p95: 200ms", color = "#2ca02c" },
              { value = 5000, label = "CRITICAL: 5s", color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "🚨 Error Rate (5xx / 4xx)"
          metrics = [
            ["CastleBackend", "HttpErrors", "StatusClass", "5xx", { stat = "Sum", color = "#d62728", label = "5xx Errors" }],
            ["CastleBackend", "HttpErrors", "StatusClass", "4xx", { stat = "Sum", color = "#ff7f0e", label = "4xx Client" }],
          ]
          view    = "timeSeries"
          stacked = true
          period  = 60
          region  = var.aws_region
          annotations = {
            horizontal = [
              { value = 10, label = "1% threshold (assuming 1000 RPM)", color = "#d62728" },
            ]
          }
        }
      },

      # ── Row 2: Queue & Tier Metrics ───────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 8
        height = 6
        properties = {
          title   = "📊 Priority Queue Depth"
          metrics = [
            ["CastleBackend", "QueueDepth", "Priority", "P1", { stat = "Average", label = "P1 (Glass Slipper + Plaid)" }],
            ["CastleBackend", "QueueDepth", "Priority", "P2", { stat = "Average", label = "P2 (Pixie Dust)" }],
            ["CastleBackend", "QueueDepth", "Priority", "P3", { stat = "Average", label = "P3 (Explorer)" }],
          ]
          view    = "timeSeries"
          stacked = true
          period  = 60
          region  = var.aws_region
          annotations = {
            horizontal = [
              { value = 1000, label = "ALERT: Queue > 1000", color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 6
        width  = 8
        height = 6
        properties = {
          title   = "👥 Active Users by Tier"
          metrics = [
            ["CastleBackend", "ActiveUsers", "Tier", "plaid_guardian", { stat = "Average", label = "Plaid Guardian" }],
            ["CastleBackend", "ActiveUsers", "Tier", "glass_slipper", { stat = "Average", label = "Glass Slipper" }],
            ["CastleBackend", "ActiveUsers", "Tier", "pixie_dust", { stat = "Average", label = "Pixie Dust" }],
            ["CastleBackend", "ActiveUsers", "Tier", "explorer", { stat = "Average", label = "Explorer" }],
          ]
          view    = "timeSeries"
          stacked = true
          period  = 300
          region  = var.aws_region
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 6
        width  = 8
        height = 6
        properties = {
          title   = "⚡ Circuit Breaker Status"
          metrics = [
            ["CastleBackend", "CircuitBreakerTrips", "Service", "disney_api", { stat = "Sum", label = "Disney API" }],
            ["CastleBackend", "CircuitBreakerTrips", "Service", "llm_token", { stat = "Sum", label = "LLM Token" }],
            ["CastleBackend", "CircuitBreakerTrips", "Service", "rate_limiter", { stat = "Sum", label = "Rate Limiter" }],
          ]
          view    = "timeSeries"
          stacked = false
          period  = 300
          region  = var.aws_region
        }
      },

      # ── Row 3: LLM & Moderation ──────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "🤖 LLM Token Usage"
          metrics = [
            ["CastleBackend", "LlmTokensUsed", "Model", "gpt-4o", { stat = "Sum", label = "GPT-4o" }],
            ["CastleBackend", "LlmTokensUsed", "Model", "gemini-1.5-flash", { stat = "Sum", label = "Gemini Flash" }],
            ["CastleBackend", "LlmTokensUsed", "Model", "gemini-1.5-pro", { stat = "Sum", label = "Gemini Pro" }],
            ["CastleBackend", "LlmTokensUsed", "Model", "gpt-4o-mini", { stat = "Sum", label = "GPT-4o Mini" }],
          ]
          view    = "timeSeries"
          stacked = true
          period  = 300
          region  = var.aws_region
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 6
        height = 6
        properties = {
          title   = "💬 Whisper Gallery Moderation"
          metrics = [
            ["CastleBackend", "ModerationDecisions", "Result", "SAFE", { stat = "Sum", label = "Published", color = "#2ca02c" }],
            ["CastleBackend", "ModerationDecisions", "Result", "REJECT", { stat = "Sum", label = "Rejected", color = "#d62728" }],
            ["CastleBackend", "ModerationDecisions", "Result", "NEEDS_REVIEW", { stat = "Sum", label = "Needs Review", color = "#ff7f0e" }],
            ["CastleBackend", "ModerationDecisions", "Result", "RUMOR", { stat = "Sum", label = "Rumor Flagged", color = "#9467bd" }],
          ]
          view    = "timeSeries"
          stacked = true
          period  = 300
          region  = var.aws_region
        }
      },
      {
        type   = "metric"
        x      = 18
        y      = 12
        width  = 6
        height = 6
        properties = {
          title   = "💰 LLM Spend ($)"
          metrics = [
            ["CastleBackend", "LlmSpendUsd", "Window", "hourly", { stat = "Maximum", label = "Hourly Spend" }],
            ["CastleBackend", "LlmSpendUsd", "Window", "daily", { stat = "Maximum", label = "Daily Spend" }],
          ]
          view    = "singleValue"
          period  = 3600
          region  = var.aws_region
        }
      },

      # ── Row 4: Infrastructure ─────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 8
        height = 6
        properties = {
          title   = "💻 EC2 CPU Utilization"
          metrics = [
            ["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", aws_autoscaling_group.castle_asg.name, { stat = "Average" }],
          ]
          view    = "timeSeries"
          period  = 60
          region  = var.aws_region
          annotations = {
            horizontal = [
              { value = 70, label = "Scale UP", color = "#ff7f0e" },
              { value = 30, label = "Scale DOWN", color = "#2ca02c" },
              { value = 90, label = "CRITICAL", color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 18
        width  = 8
        height = 6
        properties = {
          title   = "🖥️ ASG Instance Count"
          metrics = [
            ["AWS/AutoScaling", "GroupInServiceInstances", "AutoScalingGroupName", aws_autoscaling_group.castle_asg.name, { stat = "Average", label = "Running" }],
            ["AWS/AutoScaling", "GroupDesiredCapacity", "AutoScalingGroupName", aws_autoscaling_group.castle_asg.name, { stat = "Average", label = "Desired" }],
          ]
          view    = "timeSeries"
          period  = 60
          region  = var.aws_region
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 18
        width  = 8
        height = 6
        properties = {
          title   = "📡 Network I/O"
          metrics = [
            ["AWS/EC2", "NetworkIn", "AutoScalingGroupName", aws_autoscaling_group.castle_asg.name, { stat = "Average", label = "Bytes In" }],
            ["AWS/EC2", "NetworkOut", "AutoScalingGroupName", aws_autoscaling_group.castle_asg.name, { stat = "Average", label = "Bytes Out" }],
          ]
          view    = "timeSeries"
          period  = 300
          region  = var.aws_region
        }
      },
    ]
  })
}

# ── CloudWatch Alarms ────────────────────────────────────────────

# ALERT: Error rate > 1%
resource "aws_cloudwatch_metric_alarm" "error_rate_high" {
  alarm_name          = "${var.project_name}-error-rate-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HttpErrors"
  namespace           = "CastleBackend"
  period              = 300
  statistic           = "Sum"
  threshold           = 50 # ~1% at 1000 RPM over 5 min
  alarm_description   = "5xx error rate exceeded 1% - investigate immediately"
  treat_missing_data  = "notBreaching"

  dimensions = {
    StatusClass = "5xx"
  }

  alarm_actions = [var.sns_topic_arn]
  ok_actions    = [var.sns_topic_arn]
}

# ALERT: p99 latency > 5 seconds
resource "aws_cloudwatch_metric_alarm" "latency_critical" {
  alarm_name          = "${var.project_name}-latency-critical"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ApiLatencyMs"
  namespace           = "CastleBackend"
  period              = 120
  extended_statistic  = "p99"
  threshold           = 5000

  alarm_description  = "API p99 latency exceeded 5 seconds"
  treat_missing_data = "notBreaching"

  dimensions = {
    Endpoint = "ALL"
  }

  alarm_actions = [var.sns_topic_arn]
}

# ALERT: Queue depth > 1000
resource "aws_cloudwatch_metric_alarm" "queue_depth_high" {
  alarm_name          = "${var.project_name}-queue-depth-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "QueueDepth"
  namespace           = "CastleBackend"
  period              = 300
  statistic           = "Maximum"
  threshold           = 1000
  alarm_description   = "Priority queue depth exceeded 1000 - workers may be starved"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Priority = "ALL"
  }

  alarm_actions = [var.sns_topic_arn]
}

# ALERT: Any dropped session (zero tolerance)
resource "aws_cloudwatch_metric_alarm" "dropped_sessions" {
  alarm_name          = "${var.project_name}-dropped-sessions"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DroppedSessions"
  namespace           = "CastleBackend"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "CRITICAL: DROPPED SESSION DETECTED - zero tolerance breach"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.sns_topic_arn]
}

# ALERT: LLM daily spend approaching ceiling
resource "aws_cloudwatch_metric_alarm" "llm_spend_warning" {
  alarm_name          = "${var.project_name}-llm-spend-warning"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "LlmSpendUsd"
  namespace           = "CastleBackend"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 400 # $400 of $500 daily ceiling
  alarm_description   = "LLM daily spend at 80% of ceiling - circuit breaker imminent"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Window = "daily"
  }

  alarm_actions = [var.sns_topic_arn]
}
