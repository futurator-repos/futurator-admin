# Futurator Admin — Deployment Guide

Quick reference for deploying all components. All commands run from the project root.

---

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 22+
- Access to `us-east-1` region

## Key Resources

| Resource               | ID / Name                                                                    |
| ---------------------- | ---------------------------------------------------------------------------- |
| Lambda function        | `futurator-admin-production-ApiFunction-zdmmuxuc`                            |
| Lambda role            | `futurator-admin-production-ApiRole-bddrwzcu`                                |
| Admin site S3 bucket   | `futurator-admin-production-adminsiteassetsbucket-czucfmdf`                  |
| Admin CloudFront       | `EEO2UH2R6JW79` (admin.futurator.ai)                                         |
| Public site S3 bucket  | `futurator-ai-website`                                                       |
| Public site CloudFront | `E1BI1YWMTLSDTE` (futurator.ai)                                              |
| EC2 instance           | `i-0826d68c316ae97dd` (54.86.226.233)                                        |
| EC2 IAM role           | `develope-it-ec2-ssm`                                                        |
| DynamoDB tables        | `futurator-agent-jobs`, `futurator-agent-events`, `futurator-epic-workflows` |

---

## 1. Deploy Frontend (admin.futurator.ai)

```bash
# Build
NEXT_PUBLIC_API_URL=https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws \
NEXT_PUBLIC_AUTH_CALLBACK_URL=https://ne26vj552lxnebt3i5uu2gvt3a0nafwr.lambda-url.us-east-1.on.aws \
npm run build

# Upload to S3
aws s3 sync out/ s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/ --delete --region us-east-1

# Invalidate CDN cache
aws cloudfront create-invalidation --distribution-id EEO2UH2R6JW79 --paths "/*"
```

**Time:** ~30 seconds build + ~15 seconds upload + ~30 seconds invalidation propagation

---

## 2. Deploy Lambda API

```bash
# Bundle
npx esbuild functions/api/index.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile=/tmp/bundle.mjs \
  --external:@aws-sdk \
  --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);"

# Package
cd /tmp && zip -j lambda-bundle.zip bundle.mjs

# Deploy
aws lambda update-function-code \
  --function-name futurator-admin-production-ApiFunction-zdmmuxuc \
  --zip-file fileb:///tmp/lambda-bundle.zip \
  --region us-east-1
```

**Time:** ~3 seconds bundle + ~5 seconds upload

---

## 3. Deploy Both (most common)

One-liner that builds and deploys everything:

```bash
# Frontend + Lambda in sequence
NEXT_PUBLIC_API_URL=https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws \
NEXT_PUBLIC_AUTH_CALLBACK_URL=https://ne26vj552lxnebt3i5uu2gvt3a0nafwr.lambda-url.us-east-1.on.aws \
npm run build && \
npx esbuild functions/api/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=/tmp/bundle.mjs --external:@aws-sdk --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);" && \
cd /tmp && zip -j lambda-bundle.zip bundle.mjs && \
aws lambda update-function-code --function-name futurator-admin-production-ApiFunction-zdmmuxuc --zip-file fileb:///tmp/lambda-bundle.zip --region us-east-1 --query 'State' --output text && \
cd - && \
aws s3 sync out/ s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/ --delete --region us-east-1 && \
aws cloudfront create-invalidation --distribution-id EEO2UH2R6JW79 --paths "/*" --query 'Invalidation.Status' --output text
```

---

## 4. Update EC2 Daemon

When `daemon/agent-daemon.mjs` changes:

```bash
# Upload via SCP
scp -i ~/.ssh/develope-it-key.pem daemon/agent-daemon.mjs ubuntu@54.86.226.233:/opt/futurator-daemon/agent-daemon.mjs

# Restart the service
aws ssm send-command \
  --instance-ids i-0826d68c316ae97dd \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart futurator-daemon && sleep 2 && systemctl is-active futurator-daemon"]' \
  --region us-east-1
```

---

## 5. Refresh Claude Code Credentials on EC2

When Claude Code auth expires (usually after a new `claude auth login` on your Mac):

```bash
# Extract from macOS Keychain and SCP to EC2
python3 -c "
import subprocess
r = subprocess.run(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'ricardoarayafarias', '-w'], capture_output=True, text=True, timeout=5)
if r.returncode == 0 and r.stdout.strip():
    with open('/tmp/cc-tokens.txt', 'w') as f:
        f.write(r.stdout.strip())
    print(f'Extracted {len(r.stdout.strip())} chars')
else:
    print('FAILED - Keychain item not found')
"

scp -i ~/.ssh/develope-it-key.pem /tmp/cc-tokens.txt ubuntu@54.86.226.233:/home/ubuntu/.claude/.credentials.json
rm /tmp/cc-tokens.txt

# Verify
aws ssm send-command \
  --instance-ids i-0826d68c316ae97dd \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -u ubuntu claude -p \"Say hello\" --output-format json 2>&1 | head -1 | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d.get('result','FAILED'))\""]' \
  --region us-east-1
```

---

## 6. EC2 Instance Control

```bash
# Start
aws ec2 start-instances --instance-ids i-0826d68c316ae97dd --region us-east-1

# Stop
aws ec2 stop-instances --instance-ids i-0826d68c316ae97dd --region us-east-1

# Check state
aws ec2 describe-instances --instance-ids i-0826d68c316ae97dd --region us-east-1 \
  --query 'Reservations[0].Instances[0].{State:State.Name,IP:PublicIpAddress}' --output table

# SSH access
ssh -i ~/.ssh/develope-it-key.pem ubuntu@54.86.226.233
```

---

## 7. Deploy Published Apps (futurator.ai/apps/\*)

Published apps are deployed by the DeployAgent (automatic via "Publish" button in Labs).
Manual deployment:

```bash
# Build the app
cd /path/to/app && npm run build

# Upload
aws s3 sync dist/ s3://futurator-ai-website/apps/{app-name}/ --delete --region us-east-1

# Invalidate
aws cloudfront create-invalidation --distribution-id E1BI1YWMTLSDTE --paths "/apps/{app-name}/*"
```

---

## Environment Variables

### Lambda

Set via SAM/CloudFormation. Key env vars are baked into the function code:

- DynamoDB table names are in `functions/shared/dynamo-client.ts`
- EC2 instance ID is hardcoded: `i-0826d68c316ae97dd`

### EC2 Daemon

File: `/opt/futurator-daemon/.env`

```
AWS_REGION=us-east-1
AGENT_JOBS_TABLE=futurator-agent-jobs
AGENT_EVENTS_TABLE=futurator-agent-events
POLL_INTERVAL_MS=3000
MAX_CONCURRENT=5
DAEMON_SOURCE=ec2
```

### Frontend

Build-time env vars (in build command):

- `NEXT_PUBLIC_API_URL` — Lambda function URL
- `NEXT_PUBLIC_AUTH_CALLBACK_URL` — Auth callback Lambda URL

---

## Troubleshooting

### "PM Agent Failed" / Auth error

Re-run step 5 (Refresh Claude Code Credentials).

### Daemon not picking up jobs

```bash
aws ssm send-command --instance-ids i-0826d68c316ae97dd --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl status futurator-daemon; tail -20 /var/log/futurator-daemon.log"]' \
  --region us-east-1
```

### Can't SSH to EC2

Your IP may have changed. Add it to the security group:

```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id sg-018c22d0f268746f4 \
  --protocol tcp --port 22 --cidr "${MY_IP}/32" --region us-east-1
```
