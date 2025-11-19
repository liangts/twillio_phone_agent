#! /bin/bash

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-2   # or your region
ECR_REPO=twilio-phone-agent

# Create the repo (one time)
# aws ecr create-repository --repository-name $ECR_REPO || true

# Log in to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login \
    --username AWS \
    --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
echo "login complete"
# Tag and push
docker tag twilio-phone-agent:latest \
  ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest

docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest

