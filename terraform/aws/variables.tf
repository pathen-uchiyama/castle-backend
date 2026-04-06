variable "aws_region" {
  description = "AWS region to deploy in"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "digital-plaid"
}

variable "key_name" {
  description = "Name of the AWS key pair"
  type        = string
}

variable "environment" {
  description = "Execution environment (prod, dev)"
  type        = string
  default     = "prod"
}

# ── Auto Scaling Group ──────────────────────────────────────────

variable "asg_min_size" {
  description = "Minimum number of EC2 instances"
  type        = number
  default     = 1
}

variable "asg_max_size" {
  description = "Maximum number of EC2 instances"
  type        = number
  default     = 4
}

variable "asg_desired_capacity" {
  description = "Desired number of EC2 instances"
  type        = number
  default     = 1
}

variable "subnet_ids" {
  description = "VPC subnet IDs for the ASG"
  type        = list(string)
  default     = [] # Will use default VPC subnets
}

# ── Monitoring ──────────────────────────────────────────────────

variable "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarm notifications"
  type        = string
  default     = "" # Set after creating SNS topic
}

variable "admin_email" {
  description = "Admin email for CloudWatch alarm notifications"
  type        = string
  default     = "patchenu@gmail.com"
}
