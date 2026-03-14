terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# 1. Security Group
resource "aws_security_group" "castle_sg" {
  name        = "${var.project_name}-sg-${var.environment}"
  description = "Security group for Castle Backend"

  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # Recommendation: Restrict to User IP later
  }

  # HTTP
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Node backend API
  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound all
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-sg"
  }
}

# 2. IAM Role for EC2 (to read Secrets Manager)
resource "aws_iam_role" "ec2_role" {
  name = "${var.project_name}-ec2-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "secrets_access" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/SecretsManagerReadWrite" # Recommendation: Scope to specific secret later
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "${var.project_name}-instance-profile-${var.environment}"
  role = aws_iam_role.ec2_role.name
}

# 3. EC2 Instance
resource "aws_instance" "castle_server" {
  ami           = "ami-0fc6cf99992956a4a" # Latest Amazon Linux 2023 in us-east-1
  instance_type = var.instance_type
  key_name      = var.key_name

  vpc_security_group_ids = [aws_security_group.castle_sg.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_profile.name

  root_block_device {
    volume_size = 30 # Increased to 30GB to meet AMI requirements
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.project_name}-server"
  }
}

# 4. Elastic IP
resource "aws_eip" "castle_eip" {
  instance = aws_instance.castle_server.id
  domain   = "vpc"
}

# Outputs
output "public_ip" {
  value = aws_eip.castle_eip.public_ip
}

output "instance_id" {
  value = aws_instance.castle_server.id
}
