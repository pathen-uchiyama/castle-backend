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
