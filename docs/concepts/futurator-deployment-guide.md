# Futurator Deployment Playbook

> **Purpose:** A reusable guide for deploying any app on AWS under the `*.futurator.ai` domain. Based on the MBE Platform deployment as the reference implementation. Follow this pattern for every new app.

---

## The Pattern: `appname.futurator.ai`

Every Futurator app follows the same architecture:

```
appname.futurator.ai:3000
        │
        └──→ Route 53 A record (auto-updated on each deploy)
                │
                └──→ Fargate Task (Docker container)
                        │
                        ├──→ DynamoDB (app data)
                        ├──→ S3 (file storage)
                        ├──→ External APIs (Claude, Identity Broker, etc.)
                        └──→ Lambda (optional, event-driven background tasks)
```

**Shared infrastructure** (one-time, all apps use the same):

- AWS Account: `835745294770`
- Region: `us-east-1`
- VPC: `vpc-018eab54c18d93803`
- Subnets: `subnet-0b85dc11fb0285693`, `subnet-08786859267def985`
- Route 53 Hosted Zone: `Z002886634JUZ2SIMCMV0` (`futurator.ai`)
- ECS Cluster: `applicator-staging`
- IAM User: `futurator-ai-dev` (AdministratorAccess via group)

**Per-app infrastructure** (created for each new app):

- ECR repository
- CodeBuild project
- S3 source bucket
- Security group
- ECS task definition
- SSM parameters
- DynamoDB table(s) (via SST or manually)
- S3 bucket (if app needs file storage)
- Lambda function(s) (if app needs background processing)
- Route 53 A record (`appname.futurator.ai`)
- Deploy script

---

## Currently Deployed Apps

| App              | Domain                  | ECR Repo            | Status |
| ---------------- | ----------------------- | ------------------- | ------ |
| **MBE Platform** | `mbe.futurator.ai:3000` | `evidencegraph/web` | Active |

---

## Service-by-Service Breakdown

### 1. Route 53 — DNS Management

**What it does:** Translates `appname.futurator.ai` to the Fargate task's current IP address.

**Shared resource:** One hosted zone for `futurator.ai` (Zone ID: `Z002886634JUZ2SIMCMV0`) serves all apps. Each app gets its own A record.

**How it works per deploy:**

```bash
# The deploy script runs this automatically after starting a task:
aws route53 change-resource-record-sets \
  --hosted-zone-id Z002886634JUZ2SIMCMV0 \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "appname.futurator.ai",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": "NEW_TASK_IP"}]
      }
    }]
  }'
```

**TTL is 60 seconds** — after a deploy, the old IP stops resolving within 1 minute.

**Cost:** $0.50/mo per hosted zone + $0.40 per million queries. Effectively free.

**Nameserver setup (already done):** Namecheap nameservers for `futurator.ai` point to:

```
ns-1004.awsdns-61.net
ns-1377.awsdns-44.org
ns-1732.awsdns-24.co.uk
ns-414.awsdns-51.com
```

**To add a new app:** Just add an A record — no additional hosted zones needed.

---

### 2. ECR — Docker Image Registry

**What it does:** Stores the Docker images that Fargate runs. Like a private Docker Hub.

**Per-app resource:** Each app gets its own ECR repository.

| App          | ECR Repository      | Full URI                                                         |
| ------------ | ------------------- | ---------------------------------------------------------------- |
| MBE Platform | `evidencegraph/web` | `835745294770.dkr.ecr.us-east-1.amazonaws.com/evidencegraph/web` |

**Create for a new app:**

```bash
aws ecr create-repository \
  --repository-name "myapp/web" \
  --image-scanning-configuration scanOnPush=true \
  --region us-east-1
```

**Image tagging convention:**

- `latest` — always the most recent build
- `YYYYMMDD-HHMMSS` — timestamp tag for rollbacks

**Cost:** $0.10/GB/month. A typical Next.js image is ~500MB. ~$0.05/mo.

---

### 3. CodeBuild — Docker Image Builder

**What it does:** Builds Docker images from source code in the cloud. You don't need Docker installed locally.

**Per-app resource:** Each app gets its own CodeBuild project + S3 source bucket.

| App          | CodeBuild Project     | S3 Source Bucket                 |
| ------------ | --------------------- | -------------------------------- |
| MBE Platform | `evidencegraph-build` | `evidencegraph-codebuild-source` |

**How the build works:**

```
deploy.sh packages source → ZIP → uploads to S3
    │
    ▼
CodeBuild picks up the ZIP
    │
    ▼
Reads buildspec.yml:
  1. Login to ECR
  2. docker build -t <image>:latest -t <image>:<timestamp> .
  3. docker push (both tags)
    │
    ▼
Image available in ECR (~3-4 minutes)
```

**buildspec.yml template:**

```yaml
version: 0.2
phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
      - IMAGE_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$ECR_REPO
      - BUILD_TAG=$(date +%Y%m%d-%H%M%S)
  build:
    commands:
      - echo Building Docker image...
      - docker build -t $IMAGE_URI:latest -t $IMAGE_URI:$BUILD_TAG .
      - docker push $IMAGE_URI:latest
      - docker push $IMAGE_URI:$BUILD_TAG
```

**Create for a new app:**

```bash
# 1. Create S3 bucket for source
aws s3 mb s3://myapp-codebuild-source --region us-east-1

# 2. Create CodeBuild project
aws codebuild create-project \
  --name "myapp-build" \
  --source "type=S3,location=myapp-codebuild-source/source.zip,buildspec=buildspec.yml" \
  --artifacts "type=NO_ARTIFACTS" \
  --environment "type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_MEDIUM,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0,privilegedMode=true,environmentVariables=[{name=AWS_ACCOUNT_ID,value=835745294770},{name=AWS_DEFAULT_REGION,value=us-east-1},{name=ECR_REPO,value=myapp/web}]" \
  --service-role "arn:aws:iam::835745294770:role/applicator-codebuild-role" \
  --region us-east-1
```

**Cost:** $0.005/build-minute for `BUILD_GENERAL1_MEDIUM`. A typical build is ~3 min = $0.015.

**Important:** Use `public.ecr.aws/docker/library/node:20-slim` in your Dockerfile instead of `node:20-slim` to avoid Docker Hub rate limits in CodeBuild.

---

### 4. ECS Fargate — Application Hosting

**What it does:** Runs your Docker container on managed infrastructure. No servers to manage.

**Shared resource:** All apps run in the same ECS cluster (`applicator-staging`).

**Per-app resource:** Each app gets its own task definition + security group.

| App          | Task Family     | Security Group         | CPU    | Memory |
| ------------ | --------------- | ---------------------- | ------ | ------ |
| MBE Platform | `evidencegraph` | `sg-085fd0b3e6abe7fe0` | 1 vCPU | 2 GB   |

**Task definition essentials:**

```json
{
  "family": "myapp",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::835745294770:role/myapp-execution-role",
  "taskRoleArn": "arn:aws:iam::835745294770:role/myapp-task-role",
  "containerDefinitions": [
    {
      "name": "myapp-web",
      "image": "835745294770.dkr.ecr.us-east-1.amazonaws.com/myapp/web:latest",
      "portMappings": [{ "containerPort": 3000 }],
      "secrets": [{ "name": "API_KEY", "valueFrom": "/myapp/staging/API_KEY" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/myapp",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "web"
        }
      }
    }
  ]
}
```

**Create security group for a new app:**

```bash
aws ec2 create-security-group \
  --group-name "myapp-ecs-sg" \
  --description "Allow port 3000 for myapp" \
  --vpc-id vpc-018eab54c18d93803 \
  --region us-east-1

# Allow inbound port 3000 from anywhere
aws ec2 authorize-security-group-ingress \
  --group-id <new-sg-id> \
  --protocol tcp --port 3000 --cidr 0.0.0.0/0 \
  --region us-east-1
```

**Cost:** ~$0.03/hour for 1 vCPU + 2GB. $0 when stopped.

---

### 5. SSM Parameter Store — Secrets Management

**What it does:** Stores API keys and secrets that the Fargate task reads at startup. Never hardcode secrets in code or Docker images.

**Per-app resource:** Each app uses its own parameter path prefix.

| App          | SSM Path Prefix           | Parameters                         |
| ------------ | ------------------------- | ---------------------------------- |
| MBE Platform | `/evidencegraph/staging/` | 13 secrets (API keys, OAuth, etc.) |

**MBE Platform secrets:**

```
/evidencegraph/staging/NEXT_PUBLIC_IDENTITY_BROKER_URL
/evidencegraph/staging/IDENTITY_BROKER_CLIENT_ID
/evidencegraph/staging/IDENTITY_BROKER_CLIENT_SECRET
/evidencegraph/staging/IDENTITY_BROKER_WEBHOOK_SECRET
/evidencegraph/staging/AI_GATEWAY_URL
/evidencegraph/staging/AI_GATEWAY_API_KEY
/evidencegraph/staging/ANTHROPIC_API_KEY
/evidencegraph/staging/DATALAB_API_KEY
/evidencegraph/staging/VOYAGE_API_KEY
/evidencegraph/staging/GOOGLE_CLIENT_ID
/evidencegraph/staging/GOOGLE_CLIENT_SECRET
/evidencegraph/staging/OAUTH_ENCRYPTION_KEY
/evidencegraph/staging/SES_SENDER_EMAIL
```

**Store a secret:**

```bash
aws ssm put-parameter \
  --name "/myapp/staging/MY_API_KEY" \
  --value "the-actual-key" \
  --type SecureString \
  --overwrite \
  --region us-east-1
```

**Bulk store from .env.local:**

```bash
bash scripts/setup-ssm-params.sh
```

**Cost:** Free for standard parameters. $0.05/10,000 API calls for advanced.

---

### 6. IAM Roles — Permissions

**What it does:** Controls what each service can access. Two roles per app:

**Execution Role** — Used by ECS to _start_ the container:

- Pull Docker image from ECR
- Read secrets from SSM Parameter Store
- Write to CloudWatch Logs

**Task Role** — Used by the _running application_:

- Read/write DynamoDB
- Read/write S3
- Send emails via SES
- Any other AWS services the app needs

| App          | Execution Role                         | Task Role                         |
| ------------ | -------------------------------------- | --------------------------------- |
| MBE Platform | `evidencegraph-staging-execution-role` | `evidencegraph-staging-task-role` |

**Create for a new app:**

```bash
# Execution role (same for all apps, just change the SSM path)
aws iam create-role --role-name myapp-execution-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam attach-role-policy --role-name myapp-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Add SSM read permission (inline policy)
aws iam put-role-policy --role-name myapp-execution-role \
  --policy-name ssm-read \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["ssm:GetParameters","ssm:GetParameter"],
      "Resource":"arn:aws:ssm:us-east-1:835745294770:parameter/myapp/staging/*"
    },{
      "Effect":"Allow",
      "Action":"kms:Decrypt",
      "Resource":"*"
    }]
  }'

# Task role (customize per app — what does your app need access to?)
aws iam create-role --role-name myapp-task-role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'
```

---

### 7. DynamoDB — Database

**What it does:** NoSQL database for app data. Pay-per-request, scales automatically, $0 at low usage.

**Per-app resource:** Each app creates its own table(s), typically via SST.

| App          | Table                        | Key Design                               |
| ------------ | ---------------------------- | ---------------------------------------- |
| MBE Platform | `evidencegraph-...-bbkonaaf` | PK/SK + GSI1 (multi-tenant single-table) |
| MBE Platform | `Translations`               | PK/SK + GSI1                             |

**Create via SST (recommended):**

```typescript
// sst.config.ts
const table = new sst.aws.Dynamo('MyAppTable', {
  fields: { PK: 'string', SK: 'string', GSI1PK: 'string', GSI1SK: 'string' },
  primaryIndex: { hashKey: 'PK', rangeKey: 'SK' },
  globalIndexes: { GSI1: { hashKey: 'GSI1PK', rangeKey: 'GSI1SK' } },
  transform: { table: { billingMode: 'PAY_PER_REQUEST' } },
});
```

**Cost:** Pay-per-request. Effectively $0 at prototype scale.

---

### 8. S3 — File Storage

**What it does:** Stores files (PDFs, images, exports, etc.)

**Per-app resource:** Each app that needs file storage gets its own bucket.

| App          | Bucket                                     | Purpose                     |
| ------------ | ------------------------------------------ | --------------------------- |
| MBE Platform | `evidencegraph-dev-documents-835745294770` | PDF uploads, rendered pages |

**CORS note:** When using presigned URLs from the browser, the S3 bucket needs CORS configured to allow your domain:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://myapp.futurator.ai:3000"],
      "AllowedMethods": ["GET", "PUT", "POST"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
}
```

**Cost:** $0.023/GB/month + $0.005/1,000 requests. Effectively free at prototype scale.

---

### 9. Lambda — Background Processing

**What it does:** Runs code in response to events (database changes, file uploads, timers). Only used when you need automatic reactions to events.

**Not every app needs Lambda.** Only create one if you need event-driven processing.

| App          | Lambda             | Trigger          | Purpose                                          |
| ------------ | ------------------ | ---------------- | ------------------------------------------------ |
| MBE Platform | `ScoreAggregation` | DynamoDB Streams | Recalculate scores when evidence mappings change |

**When to use Lambda vs. an API route:**

| Scenario                                                   | Use                  |
| ---------------------------------------------------------- | -------------------- |
| User clicks a button → something happens                   | API route (Fargate)  |
| Data changes in DB → something should happen automatically | Lambda               |
| File uploaded to S3 → process it                           | Lambda               |
| Run something every hour                                   | Lambda + EventBridge |

**Cost:** $0.20 per 1M requests + $0.0000166667 per GB-second. Effectively free at prototype scale.

---

### 10. CloudWatch — Logs & Monitoring

**What it does:** Collects logs from all services. Essential for debugging.

**Per-app resource:** Each app gets its own log group.

| App          | Log Group            | Retention |
| ------------ | -------------------- | --------- |
| MBE Platform | `/ecs/evidencegraph` | 14 days   |

**View logs:**

```bash
aws logs tail /ecs/myapp --follow --region us-east-1
```

**Cost:** $0.50/GB ingested. Minimal at prototype scale.

---

### 11. SES — Email Sending

**What it does:** Sends emails (invitations, notifications). Shared across apps.

**Setup note:** SES starts in "sandbox mode" — can only send to verified email addresses. For production, request production access.

**Cost:** $0.10 per 1,000 emails.

---

## The Deploy Script Template

Every app uses the same deploy script structure. Copy from `scripts/deploy.sh` and change the config variables at the top:

```bash
# ── Config (CHANGE THESE PER APP) ────────────────────────────
AWS_ACCOUNT_ID="835745294770"
AWS_REGION="us-east-1"
ECR_REPO="myapp/web"                          # ← Change
ECS_CLUSTER="applicator-staging"               # ← Shared
TASK_FAMILY="myapp"                            # ← Change
CODEBUILD_PROJECT="myapp-build"                # ← Change
S3_SOURCE_BUCKET="myapp-codebuild-source"      # ← Change
SUBNETS="subnet-0b85dc11fb0285693,subnet-08786859267def985"  # ← Shared
SECURITY_GROUP="sg-XXXXXXXXXXXXXXXXX"          # ← Change (per app)
HOSTED_ZONE_ID="Z002886634JUZ2SIMCMV0"        # ← Shared
APP_DOMAIN="myapp.futurator.ai"                # ← Change
```

Everything else in the script stays the same.

---

## New App Checklist

When deploying a new app (`newapp.futurator.ai`):

### One-time setup (~30 minutes)

- [ ] **ECR:** `aws ecr create-repository --repository-name newapp/web --region us-east-1`
- [ ] **S3 (build source):** `aws s3 mb s3://newapp-codebuild-source --region us-east-1`
- [ ] **CodeBuild project:** Create with ECR_REPO=`newapp/web`
- [ ] **Security group:** Create with port 3000 open
- [ ] **IAM execution role:** Create `newapp-execution-role` with ECR + SSM + Logs access
- [ ] **IAM task role:** Create `newapp-task-role` with DynamoDB + S3 + whatever the app needs
- [ ] **CloudWatch log group:** `aws logs create-log-group --log-group-name /ecs/newapp --region us-east-1`
- [ ] **ECS task definition:** Register with image, roles, port, secrets, log config
- [ ] **SSM parameters:** Store all secrets under `/newapp/staging/`
- [ ] **DynamoDB table(s):** Create via SST or AWS CLI
- [ ] **S3 bucket:** Create if the app stores files
- [ ] **Dockerfile + buildspec.yml:** Add to the app repo
- [ ] **Deploy script:** Copy from MBE, change config variables
- [ ] **First deploy:** `bash scripts/deploy.sh`

### The result

```
newapp.futurator.ai:3000  ← Share this with your team
```

---

## Cost Summary Per App

| Resource                  | Monthly Cost | Notes                  |
| ------------------------- | ------------ | ---------------------- |
| Route 53                  | ~$0.50       | Shared across all apps |
| ECR                       | ~$0.05       | Image storage          |
| Fargate (8h/day weekdays) | ~$5          | $0 when stopped        |
| Fargate (24/7)            | ~$23         | For always-on apps     |
| DynamoDB                  | ~$0          | Pay-per-request        |
| S3                        | ~$0          | ~$0.02/GB              |
| Lambda                    | ~$0          | Pay-per-invocation     |
| CloudWatch                | ~$0.10       | Log storage            |
| CodeBuild                 | ~$0.15       | ~$0.015 per build      |
| **Total (dev usage)**     | **~$6/mo**   | Stopped overnight      |
| **Total (always-on)**     | **~$24/mo**  | Running 24/7           |

---

## Shared vs. Per-App Resources

```
SHARED (all apps)                    PER-APP (created for each)
─────────────────                    ────────────────────────────
AWS Account: 835745294770            ECR Repository
Region: us-east-1                    CodeBuild Project
VPC: vpc-018eab...                   S3 Source Bucket
Subnets: subnet-0b85..., 0878...    Security Group
ECS Cluster: applicator-staging      ECS Task Definition
Route 53 Zone: Z00288...             IAM Roles (execution + task)
IAM User: futurator-ai-dev           SSM Parameters
CodeBuild Service Role               CloudWatch Log Group
                                     DynamoDB Table(s)
                                     S3 Bucket (if needed)
                                     Lambda Function(s) (if needed)
                                     Route 53 A Record
                                     Deploy Script
```

---

## Architecture Diagram (Per App)

```
                    futurator.ai (Route 53 Hosted Zone)
                    ┌─────────────────────────────────────┐
                    │  mbe.futurator.ai  → IP of MBE task │
                    │  app2.futurator.ai → IP of App2 task│
                    │  app3.futurator.ai → IP of App3 task│
                    └─────────────┬───────────────────────┘
                                  │
                    ┌─────────────▼───────────────────────┐
                    │     ECS Cluster: applicator-staging  │
                    │                                      │
                    │  ┌──────────┐  ┌──────────┐         │
                    │  │ MBE Task │  │ App2 Task│  ...    │
                    │  │ 1vCPU/2GB│  │ 0.5vCPU  │         │
                    │  │ :3000    │  │ :3000    │         │
                    │  └────┬─────┘  └────┬─────┘         │
                    │       │             │                │
                    └───────┼─────────────┼────────────────┘
                            │             │
              ┌─────────────┼─────────────┼──────────────────┐
              │             │             │                   │
              ▼             ▼             ▼                   ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐     ┌──────────┐
        │ DynamoDB  │  │    S3    │  │   SES    │     │  Lambda  │
        │ per-app   │  │ per-app  │  │ shared   │     │ per-app  │
        │ table(s)  │  │ bucket   │  │          │     │ optional │
        └──────────┘  └──────────┘  └──────────┘     └──────────┘
```

---

## Rollback Procedure

If a deploy breaks something:

```bash
# 1. List available image tags
aws ecr list-images --repository-name myapp/web --region us-east-1 \
  --query 'imageIds[*].imageTag' --output table

# 2. Stop the broken task
bash scripts/deploy.sh stop

# 3. Start with a specific previous image tag
aws ecs run-task --cluster applicator-staging --task-definition myapp \
  --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"myapp-web","image":"835745294770.dkr.ecr.us-east-1.amazonaws.com/myapp/web:20260401-123456"}]}' \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0b85dc11fb0285693,subnet-08786859267def985],securityGroups=[sg-XXXXX],assignPublicIp=ENABLED}' \
  --region us-east-1
```

---

_This playbook is the single source of truth for deploying Futurator apps. Update it as the infrastructure evolves._
