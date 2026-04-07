# ── Auto Scaling Group (ASG) ─────────────────────────────────────

# Launch Template (replaces single EC2 instance for scaling)
resource "aws_launch_template" "castle_lt" {
  name_prefix   = "${var.project_name}-lt-"
  image_id      = "ami-0fc6cf99992956a4a" # Amazon Linux 2023, us-east-1
  instance_type = var.instance_type
  key_name      = var.key_name

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  vpc_security_group_ids = [aws_security_group.castle_sg.id]

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 30
      volume_type = "gp3"
      iops        = 3000
      throughput  = 125
    }
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -euo pipefail

    # Install Node.js 20 LTS
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs git

    # Install Redis
    yum install -y redis6
    systemctl enable redis6
    systemctl start redis6

    # Install CloudWatch Agent
    yum install -y amazon-cloudwatch-agent
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -s \
      -c ssm:AmazonCloudWatch-castle-backend || echo "CloudWatch config missing. Skipping."

    # Clone and start the backend
    cd /opt
    git clone https://github.com/pathen-uchiyama/castle-backend.git
    cd castle-backend
    npm ci
    npm run build

    # Load secrets from AWS Secrets Manager
    SECRET=$(aws secretsmanager get-secret-value \
      --secret-id castle-backend/prod \
      --query SecretString --output text)
    echo "$SECRET" | python3 -c "
    import json, sys
    d = json.load(sys.stdin)
    for k,v in d.items():
        print(f'{k}={v}')
    " > /opt/castle-backend/.env

    # systemd service
    cat > /etc/systemd/system/castle-backend.service << 'UNIT'
    [Unit]
    Description=Castle Backend API
    After=network.target redis6.service

    [Service]
    Type=simple
    User=ec2-user
    WorkingDirectory=/opt/castle-backend
    EnvironmentFile=/opt/castle-backend/.env
    ExecStart=/usr/bin/node dist/index.js
    Restart=always
    RestartSec=5
    StandardOutput=journal
    StandardError=journal

    [Install]
    WantedBy=multi-user.target
    UNIT

    systemctl daemon-reload
    systemctl enable castle-backend
    systemctl start castle-backend
  EOF
  )

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${var.project_name}-asg-instance"
      Environment = var.environment
      Service     = "castle-backend"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Auto Scaling Group
resource "aws_autoscaling_group" "castle_asg" {
  name                = "${var.project_name}-asg-${var.environment}"
  min_size            = var.asg_min_size
  max_size            = var.asg_max_size
  desired_capacity    = var.asg_desired_capacity
  vpc_zone_identifier = data.aws_subnets.default.ids
  target_group_arns   = [aws_lb_target_group.castle_tg.arn]

  launch_template {
    id      = aws_launch_template.castle_lt.id
    version = "$Latest"
  }

  health_check_type         = "EC2"
  health_check_grace_period = 300 # 5 min for Node.js startup + warm cache

  tag {
    key                 = "Name"
    value               = "${var.project_name}-asg"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }
}

# ── Scaling Policies ─────────────────────────────────────────────

# Reactive: Scale UP at 70% CPU
resource "aws_autoscaling_policy" "scale_up" {
  name                   = "${var.project_name}-scale-up"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300 # 5 min cooldown
  autoscaling_group_name = aws_autoscaling_group.castle_asg.name
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.project_name}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120 # 2 min
  statistic           = "Average"
  threshold           = 70
  alarm_description   = "Scale up when CPU > 70% for 4 minutes"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.castle_asg.name
  }

  alarm_actions = [aws_autoscaling_policy.scale_up.arn]
}

# Reactive: Scale DOWN at 30% CPU
resource "aws_autoscaling_policy" "scale_down" {
  name                   = "${var.project_name}-scale-down"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 600 # 10 min cooldown (slower to scale down)
  autoscaling_group_name = aws_autoscaling_group.castle_asg.name
}

resource "aws_cloudwatch_metric_alarm" "cpu_low" {
  alarm_name          = "${var.project_name}-cpu-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300 # 5 min
  statistic           = "Average"
  threshold           = 30
  alarm_description   = "Scale down when CPU < 30% for 15 minutes"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.castle_asg.name
  }

  alarm_actions = [aws_autoscaling_policy.scale_down.arn]
}

# ── Pre-Warming: 6:45 AM ET Daily Scale-Up ───────────────────────

# Scale to 2 instances at 6:45 AM ET (10:45 UTC) every day
resource "aws_autoscaling_schedule" "morning_warmup" {
  scheduled_action_name  = "${var.project_name}-morning-warmup"
  min_size               = 2
  max_size               = var.asg_max_size
  desired_capacity       = 2
  recurrence             = "45 10 * * *" # 10:45 UTC = 6:45 AM ET
  autoscaling_group_name = aws_autoscaling_group.castle_asg.name
}

# Scale back to 1 instance at 11:00 PM ET (03:00 UTC) — park close
resource "aws_autoscaling_schedule" "evening_cooldown" {
  scheduled_action_name  = "${var.project_name}-evening-cooldown"
  min_size               = 1
  max_size               = var.asg_max_size
  desired_capacity       = 1
  recurrence             = "0 3 * * *" # 03:00 UTC = 11:00 PM ET
  autoscaling_group_name = aws_autoscaling_group.castle_asg.name
}

# ── Outputs ──────────────────────────────────────────────────────

output "asg_name" {
  value = aws_autoscaling_group.castle_asg.name
}

output "launch_template_id" {
  value = aws_launch_template.castle_lt.id
}
