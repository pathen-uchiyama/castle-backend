#!/usr/bin/env bash
#
# Castle Backend — Infrastructure Deployment
#
# Deploys the full AWS infrastructure:
#   1. SNS topic for alarm notifications
#   2. Auto Scaling Group (EC2 fleet with pre-warming)
#   3. CloudWatch dashboard + alarm rules
#   4. Metrics emitter integration
#
# Prerequisites:
#   - AWS CLI configured: aws configure
#   - Terraform installed: brew install terraform
#   - Key pair created: aws ec2 create-key-pair --key-name digital-plaid
#
# Usage:
#   ./scripts/deploy-infra.sh plan     # Preview changes
#   ./scripts/deploy-infra.sh apply    # Deploy infrastructure
#   ./scripts/deploy-infra.sh destroy  # Tear down (CAREFUL!)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/terraform/aws"

ACTION="${1:-plan}"

echo "🏰 Castle Backend — Infrastructure Deployment"
echo "   Action: ${ACTION}"
echo "   Terraform dir: ${TERRAFORM_DIR}"
echo ""

# ── Pre-flight checks ───────────────────────────────────────────

command -v terraform >/dev/null 2>&1 || {
    echo "❌ Terraform not installed. Run: brew install terraform"
    exit 1
}

command -v aws >/dev/null 2>&1 || {
    echo "❌ AWS CLI not installed. Run: brew install awscli"
    exit 1
}

# Verify AWS credentials
if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "❌ AWS credentials not configured. Run: aws configure"
    exit 1
fi

AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region || echo "us-east-1")
echo "   AWS Account: ${AWS_ACCOUNT}"
echo "   AWS Region: ${AWS_REGION}"
echo ""

# ── Step 1: Store secrets in AWS Secrets Manager ──────────────────

echo "📦 Checking Secrets Manager..."
if ! aws secretsmanager describe-secret --secret-id "castle-backend/prod" >/dev/null 2>&1; then
    echo "   Creating secret: castle-backend/prod"
    echo "   ⚠️  You need to populate this secret with your .env values!"
    echo "   Run this after deployment:"
    echo ""
    echo "   aws secretsmanager create-secret \\"
    echo "     --name castle-backend/prod \\"
    echo "     --description 'Castle Backend production environment variables' \\"
    echo '     --secret-string "$(cat .env | python3 -c "import sys,json; print(json.dumps(dict(l.strip().split("=",1) for l in sys.stdin if l.strip() and not l.startswith("#"))))")"'
    echo ""
else
    echo "   ✅ Secret exists: castle-backend/prod"
fi

# ── Step 2: Get default VPC subnets ──────────────────────────────

echo "🌐 Resolving VPC subnets..."
DEFAULT_VPC=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query "Vpcs[0].VpcId" --output text)

if [[ "${DEFAULT_VPC}" == "None" || -z "${DEFAULT_VPC}" ]]; then
    echo "   ⚠️  No default VPC found. You need to set subnet_ids manually in terraform.tfvars"
else
    SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${DEFAULT_VPC}" --query "Subnets[].SubnetId" --output json)
    echo "   VPC: ${DEFAULT_VPC}"
    echo "   Subnets: ${SUBNETS}"

    # Write to tfvars if not already set
    if ! grep -q "subnet_ids" "${TERRAFORM_DIR}/terraform.tfvars" 2>/dev/null; then
        echo "subnet_ids = ${SUBNETS}" >> "${TERRAFORM_DIR}/terraform.tfvars"
        echo "   ✅ Subnets written to terraform.tfvars"
    fi
fi

# ── Step 3: Terraform init + action ──────────────────────────────

cd "${TERRAFORM_DIR}"

echo ""
echo "🔧 Terraform init..."
terraform init -upgrade

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "${ACTION}" in
    plan)
        echo "📋 Running terraform plan..."
        terraform plan -out=tfplan
        echo ""
        echo "To apply: ./scripts/deploy-infra.sh apply"
        ;;
    apply)
        echo "🚀 Running terraform apply..."
        terraform apply -auto-approve
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✅ Infrastructure deployed!"
        echo ""
        echo "📊 CloudWatch Dashboard:"
        echo "   https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=digital-plaid-production"
        echo ""
        echo "📧 Check your email (${ADMIN_EMAIL:-patchenu@gmail.com}) to confirm the SNS subscription"
        echo ""
        echo "📡 Next steps:"
        echo "   1. Install @aws-sdk/client-cloudwatch on EC2: npm i @aws-sdk/client-cloudwatch"
        echo "   2. Add metricsMiddleware to Express: app.use(metricsMiddleware)"
        echo "   3. Deploy backend code to EC2 via git push"
        ;;
    destroy)
        echo "💥 Running terraform destroy..."
        echo "⚠️  This will tear down ALL infrastructure including the ASG!"
        read -p "Are you sure? (yes/no): " confirm
        if [[ "${confirm}" == "yes" ]]; then
            terraform destroy -auto-approve
            echo "✅ Infrastructure destroyed"
        else
            echo "Cancelled"
        fi
        ;;
    *)
        echo "Usage: $0 {plan|apply|destroy}"
        exit 1
        ;;
esac
