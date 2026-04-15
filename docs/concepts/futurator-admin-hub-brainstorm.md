# Futurator Admin Hub — Technical Brainstorm & Planning Document

**Version:** 0.1.0-draft  
**Author:** Richie — Futurator Project Tech Owner  
**Date:** April 2026  
**Audience:** Architects, Developers, AWS Solution Architects, Project Managers  
**Purpose:** Initiate cross-functional brainstorming for the Futurator Admin Hub — a centralised obsebrvatory, control plane, and intelligence layer for all Futurator projects.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Vision & Problem Statement](#2-vision--problem-statement)
3. [Project Portfolio Overview](#3-project-portfolio-overview)
4. [MVP Phasing Strategy](#4-mvp-phasing-strategy)
5. [AWS Tagging Strategy — The Foundation](#5-aws-tagging-strategy--the-foundation)
6. [AWS Services Catalogue — Complete Reference](#6-aws-services-catalogue--complete-reference)
7. [AWS Cost Management Architecture](#7-aws-cost-management-architecture)
8. [Resource Discovery & Auditing](#8-resource-discovery--auditing)
9. [Docker & Container Strategy](#9-docker--container-strategy)
10. [GitHub Architecture & Actions Pipeline](#10-github-architecture--actions-pipeline)
11. [New Project Bootstrap — The Futurator Boilerplate](#11-new-project-bootstrap--the-futurator-boilerplate)
12. [BMAD Method Integration](#12-bmad-method-integration)
13. [Claude Skills & Code Standards](#13-claude-skills--code-standards)
14. [Identity Broker & Authentication Flow](#14-identity-broker--authentication-flow)
15. [Admin Hub Technical Architecture](#15-admin-hub-technical-architecture)
16. [DynamoDB Schema Design](#16-dynamodb-schema-design)
17. [Living Documentation System](#17-living-documentation-system)
18. [Cross-Project Service Matrix](#18-cross-project-service-matrix)
19. [Security & GDPR Considerations](#19-security--gdpr-considerations)
20. [Open Questions & Discussion Points](#20-open-questions--discussion-points)
21. [Appendices](#21-appendices)

---

## 1. Executive Summary

Futurator is a growing portfolio of 9+ AI-powered applications spanning web builders, e-commerce, debate engines, music tools, architectural platforms, and project management. All projects are deployed on AWS (eu-central-1) using a shared technology stack: React/TypeScript frontends, AWS-native backends (ECS Fargate, Lambda, DynamoDB, S3, CloudFront, API Gateway, Cognito, Bedrock), and a centralised Identity Broker for authentication.

As the portfolio grows, we face compounding complexity in cost management, resource consistency, documentation freshness, and operational visibility. The **Futurator Admin Hub** (`futurator.ai/admin`) is a centralised platform to observe, control, and optimise every project from a single pane of glass.

This document is intended to seed brainstorming across disciplines. Every section contains both concrete proposals and open questions. Nothing is final — everything is up for debate.

---

## 2. Vision & Problem Statement

### What problems are we solving?

1. **Cost blindness** — With 9+ projects on a single AWS account, costs are tangled. We cannot easily answer "how much does Contento cost per month?" without manual tag filtering in the AWS Console.

2. **Resource sprawl** — DynamoDB tables, S3 buckets, Lambda functions, ECS services multiply across projects. Naming conventions drift. Configurations diverge. Zombie resources accumulate.

3. **Documentation decay** — Architecture docs go stale within days of a sprint. Feature lists live in scattered Notion pages, Slack threads, and developer heads. There is no single source of truth for "what does this project do and how is it built?"

4. **Operational toil** — Starting/stopping EC2 instances, checking CloudWatch alarms, verifying Cognito user pools — all require manual AWS Console sessions. This does not scale.

5. **Onboarding friction** — Starting a new project requires recreating the same boilerplate, CI/CD pipeline, auth flow, linting config, and BMAD structure from scratch (or worse, copying from an existing project and inheriting its technical debt).

6. **No cross-project intelligence** — We cannot easily answer: "Which projects share this Lambda layer?", "What's the total Bedrock spend across all projects?", "Are all projects using the same Node.js runtime version?"

### What does success look like?

A developer or PM opens `futurator.ai/admin` and within seconds can see every project's status, costs, resources, documentation, and health. Starting a new project takes 15 minutes, not 3 days. Cost anomalies trigger alerts before the bill arrives. Architecture documentation updates itself.

---

## 3. Project Portfolio Overview

### 3.1 Project Categories

**Independent (with Companies)** — Revenue-generating projects with external clients:

| Project      | Status   | Brief                                                                                                                                                       | Clients                                |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Contento** | Beta     | AI-based web builder (WordPress/Wix competitor) for small entrepreneurs. Headless CMS, booking, payments, newsletters, multi-language, social embeds.       | 5Seasons, WineSisters, Collafranceschi |
| **Sellebra** | Planning | AI-based full e-commerce with omnichannel PIM (Shopify competitor). Multi-channel selling (Amazon, Etsy, Zalando, Walmart), B2B modules, audits, templates. | Cayambe, Missangas&Co                  |

**Joint Ventures** — Co-developed with partner organisations:

| Project | Status      | Brief                                                                                                                                                                                |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MBE** | In Progress | AI-based SaaS for architects. Theoretical frameworks, BIM integration (Pascal Editor), VR+EEG validation, document intelligence with Voyage 4 embeddings and 357-indicator taxonomy. |

**Independent (Personal)** — Complex solo projects, some public-facing:

| Project               | Status      | Brief                                                                                                                                                                        |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MyApplicator**      | Beta        | AI-based CV engine, interview simulator, interactive profiles. LinkedIn integration, TTS/STT, PDF generation, multi-platform job scraping via Playwright.                    |
| **GoMAD / Debatator** | Beta        | Multi-agent debate engine. Six Thinking Hats architecture, Memgraph knowledge graph, heavy TTS, Google tools, web scraping, 100+ page document processing.                   |
| **Atlassinator**      | Private     | AI for Atlassian consultants. Python code generation from intent, sandboxed execution, JET token auth, Neo4j knowledge graph, shareable dashboards.                          |
| **Dasher**            | In Progress | AI-based dashboard engine (PowerBI/Tableau alternative). Conversational UI, 15 chart types, shareable dashboards, data privacy focus.                                        |
| **Songster**          | In Progress | AI music collaboration & song storyboard ("Figma for song arrangements"). Drag-and-drop sections, AI audio inpainting, multi-stem chord detection, Demucs/WhisperX pipeline. |
| **Mycelium**          | In Progress | GraphRAG project management. Memgraph knowledge graph, cold-start document decomposition, cross-project integration.                                                         |

### 3.2 Shared Infrastructure

All projects share:

- **Identity Broker** — Centralised Cognito-based auth service at `futurator.ai` level
- **Deployment pattern** — Single S3/CloudFront distribution with SPA routing via CloudFront Functions, apps at `futurator.ai/projects/*`
- **Container runtime** — ECS Fargate for backend services
- **AI backbone** — AWS Bedrock for LLM capabilities
- **Data layer** — DynamoDB single-table designs per project
- **Region** — eu-central-1 (GDPR compliance)

### 3.3 AWS Service × Project Matrix

| Service     | Contento | Sellebra | MBE | Applicator | GoMAD | Atlassinator | Dasher | Songster | Mycelium |
| ----------- | :------: | :------: | :-: | :--------: | :---: | :----------: | :----: | :------: | :------: |
| ECS Fargate |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    ●     |
| DynamoDB    |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    ●     |
| S3          |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    ●     |
| CloudFront  |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    ●     |
| Lambda      |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    ●     |
| API Gateway |    ●     |    ●     |  ●  |     ●      |   ●   |      ●       |   ●    |    ●     |    —     |
| Cognito     |    ●     |    ●     |  ●  |     ●      |   ●   |      —       |   —    |    —     |    —     |
| SQS         |    ●     |    ●     |  —  |     ●      |   —   |      —       |   —    |    ●     |    —     |
| Bedrock     |    ●     |    ●     |  ●  |     ●      |   ●   |      —       |   ●    |    —     |    —     |
| EC2         |    —     |    —     |  —  |     —      |   ●   |      —       |   —    |    —     |    ●     |

**Key observations for discussion:**

- ECS Fargate, DynamoDB, S3, CloudFront, and Lambda are universal — consistency auditing here has the highest ROI.
- EC2 only exists in GoMAD (Memgraph) and Mycelium (Memgraph) — prime candidates for scheduled start/stop.
- Cognito is used by 5/9 projects — the Identity Broker should eventually unify all.
- SQS is used by 4/9 — async processing patterns should be standardised.

---

## 4. MVP Phasing Strategy

### MVP 1 — Project Observatory (Target: 6–8 weeks)

The read-only layer. See everything, touch nothing.

| Feature                   | Description                                                                       | AWS APIs / Services                     | Priority |
| ------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| Project Registry          | GitHub-linked project map with briefs, extended docs, feature lists               | GitHub API v4 (GraphQL), DynamoDB       | P0       |
| AWS Resource Map          | Per-project inventory of all AWS resources (tables, buckets, functions, services) | Resource Groups Tagging API, AWS Config | P0       |
| AWS Cost Dashboard        | Real-time cost tracking per project, trends, forecasts, anomaly detection         | Cost Explorer API, Budgets API          | P0       |
| Consistency Auditor (v1)  | List resources per project with names, configs. Visual spotting of drift.         | AWS Config, CloudWatch                  | P1       |
| Living Documentation (v1) | Auto-sync project manifests from GitHub on push                                   | GitHub Webhooks, EventBridge            | P1       |

### MVP 2 — Control Plane (Target: 4–6 weeks after MVP1)

The write layer. Act on what you see.

| Feature              | Description                                                                   | AWS APIs / Services                    | Priority |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------- | -------- |
| Identity Dashboard   | Active users per app, user status, access control                             | Cognito Admin API, Identity Broker     | P0       |
| Resource Scheduler   | Event-based start/stop of EC2, ECS tasks, RDS instances                       | Systems Manager, EventBridge Scheduler | P0       |
| Multi-Provider Costs | Aggregate external costs: GCP, ElevenLabs, AI providers, 3rd party connectors | Custom Lambda aggregator               | P1       |
| Alert Management     | Centralised CloudWatch alarms, budget breach notifications                    | CloudWatch, SNS, Budgets               | P1       |

### MVP 3 — Intelligence Layer (Target: 6–8 weeks after MVP2)

The smart layer. Let the platform think for you.

| Feature                     | Description                                                                       | AWS APIs / Services                     | Priority |
| --------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| Cross-Project Analytics     | Shared infrastructure patterns, dependency mapping, optimisation suggestions      | X-Ray, Custom Analysis Lambdas          | P0       |
| Microservice Registry       | Service discovery, health checks, dependency graph of shared services             | Cloud Map, Service Discovery            | P0       |
| AI Ops Assistant            | Natural language queries about infrastructure: "What's my most expensive Lambda?" | Bedrock, Custom RAG over Admin Hub data | P1       |
| Automated Consistency Rules | AWS Config custom rules that enforce naming, runtime versions, config alignment   | AWS Config Rules, Lambda                | P1       |
| New Project Wizard          | Guided UI to spin up a new project from the Futurator Boilerplate                 | GitHub API, CloudFormation/CDK          | P2       |

### Discussion points:

- Should MVP1 include any write operations (e.g., tagging untagged resources)?
- Should the cost dashboard show forecasts or just historical data in v1?
- How aggressive should the consistency auditor be in v1? Advisory vs. blocking?
- What's the latency tolerance for cost data? Cost Explorer has ~24h delay.

---

## 5. AWS Tagging Strategy — The Foundation

### 5.1 Why This Matters

The entire Admin Hub depends on consistent, machine-readable tags on every AWS resource. Without tags:

- Cost Explorer cannot allocate costs per project
- Resource Groups cannot discover resources per project
- AWS Config cannot audit cross-project consistency
- The resource scheduler cannot identify what belongs where

**This is the single highest-ROI task in the entire initiative.** Retroactively tagging existing resources and enforcing tags on creation is the critical path.

### 5.2 Mandatory Tag Schema

Every AWS resource across all Futurator projects must have these tags:

| Tag Key                  | Example Values                                                                                                                         | Purpose                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `futurator:project`      | `contento`, `sellebra`, `mbe`, `applicator`, `gomad`, `atlassinator`, `dasher`, `songster`, `mycelium`, `admin-hub`, `identity-broker` | Primary cost allocation and resource grouping                       |
| `futurator:environment`  | `production`, `staging`, `development`, `shared`                                                                                       | Environment isolation                                               |
| `futurator:service-role` | `api`, `worker`, `storage`, `cdn`, `auth`, `queue`, `compute`, `ai`, `monitoring`                                                      | Functional classification for cross-project auditing                |
| `futurator:managed-by`   | `cdk`, `terraform`, `manual`, `github-actions`                                                                                         | Tracks how the resource was provisioned                             |
| `futurator:cost-center`  | `client-5seasons`, `personal`, `shared-infra`                                                                                          | Fine-grained cost allocation (especially for multi-tenant projects) |

### 5.3 Optional Tags

| Tag Key                         | Example Values                                  | Purpose                                           |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `futurator:team`                | `core`, `mbe-team`, `client-services`           | Team ownership                                    |
| `futurator:data-classification` | `public`, `internal`, `confidential`, `pii`     | GDPR/data governance                              |
| `futurator:ttl`                 | `2026-06-30`, `permanent`                       | For temporary resources — auto-cleanup candidates |
| `futurator:version`             | `v2.1.0`                                        | Track deployed versions on ECS/Lambda resources   |
| `futurator:feature`             | `booking-system`, `pim-sync`, `chord-detection` | Map resources to specific features                |

### 5.4 Tag Enforcement Strategy

**Immediate (Week 1):**

1. Audit all existing resources using AWS Resource Groups Tagging API — generate a report of untagged resources.
2. Bulk-tag existing resources using a one-time Lambda script.
3. Add mandatory tags to all CDK constructs / CloudFormation templates.

**Ongoing:**

4. **AWS Config Rule** — `required-tags` managed rule that flags non-compliant resources.
5. **Service Control Policy (SCP)** — If using AWS Organizations, deny resource creation without mandatory tags.
6. **CDK Aspect** — Custom CDK Aspect that automatically applies `futurator:project` and `futurator:environment` to every construct:

```typescript
// Example CDK Aspect for tag enforcement
class FuturatorTagAspect implements cdk.IAspect {
  constructor(
    private project: string,
    private environment: string,
  ) {}

  visit(node: IConstruct): void {
    if (Tags.of(node)) {
      Tags.of(node).add('futurator:project', this.project);
      Tags.of(node).add('futurator:environment', this.environment);
      Tags.of(node).add('futurator:managed-by', 'cdk');
    }
  }
}
```

7. **GitHub Action check** — Pre-deploy step that validates all CloudFormation/CDK outputs include mandatory tags.
8. **Admin Hub dashboard** — Tag compliance score per project (% of resources properly tagged).

### 5.5 Cost Allocation Tags

AWS Cost Explorer requires tags to be activated as "Cost Allocation Tags" in the Billing console. This is a one-time manual step:

1. Go to AWS Billing → Cost Allocation Tags
2. Activate `futurator:project`, `futurator:environment`, `futurator:cost-center`
3. Wait 24 hours for tags to appear in Cost Explorer data

**Discussion points:**

- Should we use a separate AWS account per project (AWS Organizations) or a single account with tags?
- How do we handle shared resources (e.g., the Identity Broker Cognito pool)? Tag as `futurator:project=shared-infra`?
- Should the tagging strategy be documented in each project's `.futurator/manifest.json` or centrally?

---

## 6. AWS Services Catalogue — Complete Reference

This section catalogues every AWS service that is currently used or could be used across the Futurator portfolio. The intent is to ensure the Admin Hub can monitor and manage all of them.

### 6.1 Compute

| Service               | Current Usage                                                    | Admin Hub Role                                                                           | API for Discovery                                                            |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **ECS Fargate**       | All 9 projects — primary backend runtime                         | Monitor task counts, CPU/memory utilisation, deployment status, task definition versions | ECS API (`DescribeServices`, `ListTasks`), CloudWatch Container Insights     |
| **Lambda**            | All 9 projects — event handlers, API endpoints, async processors | Track function count, runtime versions, memory configs, invocation metrics, cold starts  | Lambda API (`ListFunctions`, `GetFunctionConfiguration`), CloudWatch Metrics |
| **EC2**               | GoMAD + Mycelium (Memgraph instances)                            | Start/stop scheduling, instance type auditing, utilisation monitoring                    | EC2 API (`DescribeInstances`, `StartInstances`, `StopInstances`), CloudWatch |
| **App Runner**        | Not currently used                                               | Could simplify deployment for simpler services                                           | App Runner API                                                               |
| **Elastic Beanstalk** | Not currently used                                               | Alternative managed deployment                                                           | EB API                                                                       |
| **Batch**             | Not currently used                                               | Potential for heavy audio/document processing jobs (Songster, GoMAD)                     | Batch API                                                                    |
| **Lightsail**         | Not currently used                                               | Budget-friendly option for low-traffic client sites                                      | Lightsail API                                                                |

### 6.2 Containers & Orchestration

| Service                              | Current Usage                       | Admin Hub Role                                                                        | API for Discovery                                                           |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **ECR (Elastic Container Registry)** | All projects — Docker image storage | Image inventory, vulnerability scanning status, image size trends, lifecycle policies | ECR API (`DescribeRepositories`, `ListImages`, `DescribeImageScanFindings`) |
| **ECS (Cluster Management)**         | Cluster-level orchestration         | Cluster health, capacity providers, service auto-scaling configs                      | ECS API (`DescribeClusters`, `ListServices`)                                |
| **EKS**                              | Not currently used                  | Future option if container orchestration complexity grows beyond ECS                  | EKS API                                                                     |

### 6.3 Storage

| Service        | Current Usage                                                            | Admin Hub Role                                                                                         | API for Discovery                                           |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **S3**         | All projects — static assets, uploads, CloudFront origins, build outputs | Bucket inventory, storage size per project, lifecycle policies, public access audit, encryption status | S3 API (`ListBuckets`, `GetBucketTagging`), S3 Storage Lens |
| **EFS**        | Not currently used                                                       | Shared filesystem for ECS tasks if needed                                                              | EFS API                                                     |
| **S3 Glacier** | Not currently used                                                       | Archival of old assets, logs, processed documents                                                      | S3 Lifecycle Policies                                       |

### 6.4 Database

| Service                    | Current Usage                                            | Admin Hub Role                                                                                                                 | API for Discovery                                        |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **DynamoDB**               | All projects — primary data store (single-table designs) | Table inventory, capacity mode (on-demand vs provisioned), RCU/WCU metrics, GSI count, item count, storage size, backup status | DynamoDB API (`ListTables`, `DescribeTable`), CloudWatch |
| **DynamoDB Streams**       | Some projects — event-driven patterns                    | Stream status per table, Lambda trigger mapping                                                                                | DynamoDB Streams API                                     |
| **DynamoDB DAX**           | Not currently used                                       | Caching layer for read-heavy DynamoDB tables                                                                                   | DAX API                                                  |
| **ElastiCache (Redis)**    | Not currently used                                       | Session caching, rate limiting, real-time features                                                                             | ElastiCache API                                          |
| **RDS (PostgreSQL/MySQL)** | Not currently used                                       | If any project needs relational data (Sellebra PIM?)                                                                           | RDS API                                                  |
| **Neptune**                | Not currently used                                       | Managed graph database (alternative to self-hosted Memgraph on EC2)                                                            | Neptune API                                              |
| **OpenSearch**             | Not currently used                                       | Full-text search across projects (Applicator job search, Contento content search)                                              | OpenSearch API                                           |
| **MemoryDB for Redis**     | Not currently used                                       | Durable Redis-compatible store                                                                                                 | MemoryDB API                                             |
| **Timestream**             | Not currently used                                       | Time-series data (cost trends, usage metrics in Admin Hub itself)                                                              | Timestream API                                           |
| **QLDB**                   | Not currently used                                       | Immutable audit ledger (Sellebra transactions, Atlassinator actions)                                                           | QLDB API                                                 |

### 6.5 Networking & Content Delivery

| Service                    | Current Usage                                      | Admin Hub Role                                                                                      | API for Discovery                                          |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **CloudFront**             | All projects — CDN and SPA routing                 | Distribution inventory, cache hit ratios, bandwidth costs, Lambda@Edge / CloudFront Functions audit | CloudFront API (`ListDistributions`), CloudWatch           |
| **API Gateway**            | Most projects — REST/HTTP API endpoints            | API inventory, endpoint count, throttling configs, usage plans, latency metrics                     | API Gateway API (`GetRestApis`, `GetStages`)               |
| **Route 53**               | DNS management for futurator.ai and client domains | Domain inventory, health checks, DNS record audit                                                   | Route 53 API (`ListHostedZones`, `ListResourceRecordSets`) |
| **VPC**                    | Networking for ECS, EC2                            | VPC layout, security group audit, NAT Gateway costs                                                 | EC2/VPC API                                                |
| **Elastic Load Balancing** | ALBs for ECS services                              | Load balancer inventory, target group health, SSL cert status                                       | ELB API                                                    |
| **AWS Global Accelerator** | Not currently used                                 | Performance optimisation for global users                                                           | Global Accelerator API                                     |
| **PrivateLink**            | Not currently used                                 | Private connectivity to AWS services from VPC                                                       | VPC Endpoint API                                           |
| **CloudFront Functions**   | SPA routing for `futurator.ai/projects/*`          | Function inventory, invocation metrics                                                              | CloudFront API                                             |
| **Lambda@Edge**            | Multi-tenant routing in Contento/Sellebra          | Function association audit, latency metrics                                                         | Lambda/CloudFront API                                      |

### 6.6 AI & Machine Learning

| Service         | Current Usage                             | Admin Hub Role                                                                | API for Discovery                                        |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Bedrock**     | 7/9 projects — Claude, Titan, embeddings  | Model usage per project, token counts, cost per model, prompt caching metrics | Bedrock API (`ListFoundationModels`), CloudWatch Metrics |
| **SageMaker**   | Not currently used                        | Custom model hosting (fine-tuned models for specific projects)                | SageMaker API                                            |
| **Transcribe**  | Potential for Songster, GoMAD, Applicator | Audio transcription usage and cost                                            | Transcribe API                                           |
| **Polly**       | Potential TTS across projects             | Speech synthesis usage                                                        | Polly API                                                |
| **Comprehend**  | Not currently used                        | NLP analysis (sentiment, entities, language detection)                        | Comprehend API                                           |
| **Rekognition** | Not currently used                        | Image/video analysis                                                          | Rekognition API                                          |
| **Textract**    | Not currently used                        | Document OCR (alternative to current approaches)                              | Textract API                                             |
| **Kendra**      | Not currently used                        | Enterprise search (alternative to custom RAG)                                 | Kendra API                                               |

### 6.7 Integration & Messaging

| Service            | Current Usage                     | Admin Hub Role                                                             | API for Discovery                                        |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| **SQS**            | 4 projects — async job processing | Queue inventory, message counts, DLQ monitoring, age of oldest message     | SQS API (`ListQueues`, `GetQueueAttributes`), CloudWatch |
| **SNS**            | Budget alerts, notifications      | Topic inventory, subscription audit                                        | SNS API (`ListTopics`, `ListSubscriptions`)              |
| **EventBridge**    | Event routing, scheduled tasks    | Rule inventory, event patterns, target mapping                             | EventBridge API (`ListRules`, `ListTargets`)             |
| **Step Functions** | Not currently used                | Complex workflow orchestration (Applicator CV pipeline, GoMAD debate flow) | Step Functions API                                       |
| **AppSync**        | Not currently used                | Managed GraphQL API (alternative to API Gateway for real-time features)    | AppSync API                                              |
| **Kinesis**        | Not currently used                | Real-time data streaming (high-volume event processing)                    | Kinesis API                                              |
| **MQ (RabbitMQ)**  | Not currently used                | Message broker for complex routing                                         | MQ API                                                   |

### 6.8 Security & Identity

| Service                       | Current Usage                          | Admin Hub Role                                                             | API for Discovery                                              |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Cognito**                   | 5 projects via Identity Broker         | User pool inventory, user counts per app, auth flow configs, MFA status    | Cognito API (`ListUserPools`, `DescribeUserPool`, `ListUsers`) |
| **IAM**                       | All projects — service roles, policies | Role inventory, policy audit, least-privilege analysis, unused permissions | IAM API (`ListRoles`, `ListPolicies`), IAM Access Analyzer     |
| **Secrets Manager**           | API keys, database credentials         | Secret inventory, rotation status, access audit                            | Secrets Manager API (`ListSecrets`)                            |
| **KMS**                       | Encryption keys for DynamoDB, S3       | Key inventory, usage audit, rotation schedule                              | KMS API (`ListKeys`, `DescribeKey`)                            |
| **WAF**                       | CloudFront/ALB protection              | Rule inventory, blocked request metrics                                    | WAF API (`ListWebACLs`)                                        |
| **Shield**                    | DDoS protection                        | Protection status per resource                                             | Shield API                                                     |
| **GuardDuty**                 | Threat detection                       | Finding inventory, severity trends                                         | GuardDuty API (`ListFindings`)                                 |
| **Security Hub**              | Centralised security findings          | Compliance score, finding aggregation                                      | Security Hub API                                               |
| **Certificate Manager**       | SSL/TLS certificates                   | Certificate inventory, expiry monitoring                                   | ACM API (`ListCertificates`)                                   |
| **IAM Identity Center (SSO)** | Not currently used                     | Centralised SSO for admin access                                           | SSO API                                                        |

### 6.9 Monitoring & Observability

| Service                | Current Usage                      | Admin Hub Role                                                            | API for Discovery                                  |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| **CloudWatch Metrics** | All projects — basic monitoring    | Metric aggregation per project, custom dashboards                         | CloudWatch API (`GetMetricData`, `ListMetrics`)    |
| **CloudWatch Logs**    | All projects — application logging | Log group inventory, storage costs, retention policies, error rate trends | CloudWatch Logs API (`DescribeLogGroups`)          |
| **CloudWatch Alarms**  | Various — threshold alerting       | Alarm inventory, alarm state, notification targets                        | CloudWatch API (`DescribeAlarms`)                  |
| **X-Ray**              | Not consistently used              | Distributed tracing across microservices, cross-project call maps         | X-Ray API (`GetTraceSummaries`, `GetServiceGraph`) |
| **CloudTrail**         | Account-level audit logging        | API call history, security audit, change tracking                         | CloudTrail API (`LookupEvents`)                    |
| **AWS Health**         | Service health events              | Proactive notification of AWS issues affecting our services               | Health API (`DescribeEvents`)                      |
| **Trusted Advisor**    | Account-level recommendations      | Cost optimisation, security, fault tolerance, service limits              | Trusted Advisor API                                |
| **Compute Optimizer**  | Not currently used                 | Right-sizing recommendations for EC2, Lambda, ECS                         | Compute Optimizer API                              |

### 6.10 DevOps & Deployment

| Service             | Current Usage                               | Admin Hub Role                                              | API for Discovery                                     |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| **CloudFormation**  | Infrastructure as Code (via CDK)            | Stack inventory, drift detection, resource counts per stack | CloudFormation API (`ListStacks`, `DetectStackDrift`) |
| **CDK**             | Infrastructure definition                   | Not directly queryable — outputs to CloudFormation          | Via CloudFormation API                                |
| **CodePipeline**    | Not currently used (GitHub Actions instead) | Alternative CI/CD                                           | CodePipeline API                                      |
| **CodeBuild**       | Not currently used                          | Alternative build service                                   | CodeBuild API                                         |
| **Systems Manager** | Potential for resource management           | Parameter store configs, run commands, maintenance windows  | SSM API                                               |
| **Service Catalog** | Not currently used                          | Standardised project templates                              | Service Catalog API                                   |

### 6.11 Cost Management

| Service                    | Current Usage                      | Admin Hub Role                                                                 | API for Discovery                                        |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **Cost Explorer**          | Manual console usage               | **Primary cost data source** — programmatic access to cost/usage data by tag   | Cost Explorer API (`GetCostAndUsage`, `GetCostForecast`) |
| **AWS Budgets**            | Not currently configured           | Per-project budget thresholds with automated alerts                            | Budgets API (`CreateBudget`, `DescribeBudgets`)          |
| **Cost Anomaly Detection** | Not currently configured           | ML-based anomaly detection on spending patterns                                | Cost Explorer API (`GetAnomalies`)                       |
| **Savings Plans**          | To be evaluated                    | Compute savings across ECS Fargate and Lambda                                  | Savings Plans API                                        |
| **Reserved Instances**     | To be evaluated for EC2 (Memgraph) | Long-term EC2 cost reduction                                                   | EC2 API                                                  |
| **Billing Conductor**      | Not currently used                 | Custom billing groups (useful for client cost allocation in Contento/Sellebra) | Billing Conductor API                                    |
| **S3 Storage Lens**        | Not currently used                 | Organisation-wide S3 storage analytics                                         | S3 Storage Lens API                                      |

### 6.12 Other Services to Consider

| Service                 | Potential Use                            | Notes                                                       |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| **Amplify**             | Simplified frontend hosting              | Could replace S3+CloudFront for simpler projects            |
| **AppConfig**           | Feature flags, dynamic configuration     | Centralised feature flag management across projects         |
| **Chatbot**             | Slack/Teams notifications from AWS       | Alert routing to team channels                              |
| **IoT Core**            | If MBE expands to building sensors       | MQTT for real-time sensor data                              |
| **Pinpoint**            | Email/SMS campaigns for Contento clients | Marketing automation                                        |
| **SES**                 | Transactional email across all projects  | Email sending (notifications, password resets, newsletters) |
| **MediaConvert**        | Video processing for Songster/GoMAD      | Managed video transcoding                                   |
| **Elemental MediaLive** | Live streaming                           | If any project needs live capabilities                      |

### Discussion points:

- Which services in the "not currently used" categories should we evaluate immediately?
- Is Neptune a better fit than self-hosted Memgraph on EC2 for GoMAD/Mycelium?
- Should we adopt Step Functions for complex workflows instead of custom SQS-based orchestration?
- Is OpenSearch worth adopting for cross-project search capabilities?
- Should we migrate from custom Bedrock integration to SageMaker for fine-tuned models?

---

## 7. AWS Cost Management Architecture

### 7.1 Data Sources

```
AWS Cost Explorer API (24h delay)
  ├── GetCostAndUsage — historical cost data by tag
  ├── GetCostForecast — projected spend based on trends
  └── GetAnomalies — ML-detected spending anomalies

AWS Budgets API (near real-time)
  ├── Per-project monthly budgets
  ├── Alert thresholds (50%, 80%, 100%, 120%)
  └── SNS notifications → Admin Hub events

CloudWatch Metrics (real-time)
  ├── Per-service utilisation (DynamoDB RCU/WCU, Lambda invocations, etc.)
  └── Custom metrics from applications
```

### 7.2 Aggregation Lambda (Daily)

A scheduled Lambda runs daily to pull cost data and store it in DynamoDB:

```
EventBridge (cron: 0 6 * * *) → Lambda (cost-aggregator)
  ├── Call Cost Explorer API with GroupBy = [futurator:project, SERVICE]
  ├── Call Cost Explorer API with GroupBy = [futurator:project, USAGE_TYPE]
  ├── Call GetCostForecast for next 30 days
  ├── Call GetAnomalies for last 7 days
  ├── Store results in DynamoDB (PK=PROJECT#x, SK=COST#2026-04-02)
  └── If any anomaly detected → SNS → Admin Hub notification
```

### 7.3 Multi-Provider Cost Aggregation (MVP2)

For non-AWS costs, we need a different approach per provider:

| Provider                   | Data Source                     | Frequency          |
| -------------------------- | ------------------------------- | ------------------ |
| AWS                        | Cost Explorer API               | Daily (automated)  |
| Google Cloud (if used)     | BigQuery Billing Export         | Daily (automated)  |
| ElevenLabs                 | ElevenLabs API (`/usage`)       | Daily (automated)  |
| OpenAI                     | OpenAI API (`/usage`)           | Daily (automated)  |
| Anthropic (non-Bedrock)    | Anthropic API (if direct usage) | Daily (automated)  |
| GitHub                     | GitHub API (Actions minutes)    | Weekly (automated) |
| Vercel / Netlify (if used) | Their respective APIs           | Daily (automated)  |
| Manual costs               | Admin Hub UI input              | As needed (manual) |

Each provider gets a Lambda function that pulls usage data and normalises it into a common cost record in DynamoDB.

### 7.4 Cost Dashboard Features

**Per-project view:**

- Monthly cost breakdown by service (pie chart)
- Daily cost trend (line chart, 30/60/90 day)
- Cost forecast for current month
- Top 5 most expensive resources
- Month-over-month change (%)
- Budget utilisation bar

**Portfolio view:**

- Total monthly cost across all projects
- Project ranking by cost
- Service ranking by cost (which AWS service costs most overall?)
- Cost per client (for Contento/Sellebra)
- Savings opportunities (underutilised resources, right-sizing recommendations)

### Discussion points:

- What budget thresholds make sense per project? Fixed amounts or % of revenue?
- Should cost alerts go to Slack, email, or the Admin Hub notification centre?
- How granular should cost tracking be? Per-feature? Per-client?
- Should we implement chargeback to clients (e.g., 5Seasons pays X% of Contento costs)?

---

## 8. Resource Discovery & Auditing

### 8.1 Discovery Pipeline

```
EventBridge (cron: 0 7 * * *) → Lambda (resource-discoverer)
  ├── Resource Groups Tagging API
  │   └── GetResources(TagFilters=[futurator:project=*]) → all tagged resources
  ├── AWS Config
  │   └── SelectAggregateResourceCounts → resource type distribution
  │   └── GetResourceConfigHistory → config changes over time
  ├── Per-service deep discovery
  │   ├── DynamoDB: ListTables → DescribeTable (each)
  │   ├── S3: ListBuckets → GetBucketTagging (each)
  │   ├── Lambda: ListFunctions → GetFunctionConfiguration (each)
  │   ├── ECS: DescribeClusters → DescribeServices → DescribeTasks
  │   ├── ECR: DescribeRepositories → ListImages
  │   └── [... for each service type]
  └── Store results in DynamoDB (PK=PROJECT#x, SK=AWS#service#resource-name)
```

### 8.2 Consistency Audit Rules

The consistency auditor checks cross-project alignment on:

| Audit Rule              | What It Checks                                                           | Severity |
| ----------------------- | ------------------------------------------------------------------------ | -------- |
| **Naming Convention**   | DynamoDB tables follow `{project}-{environment}-{entity}` pattern        | Warning  |
| **S3 Bucket Naming**    | Buckets follow `futurator-{project}-{purpose}-{env}` pattern             | Warning  |
| **Lambda Runtime**      | All Lambda functions use the same Node.js/Python version                 | Error    |
| **Lambda Memory**       | Lambda memory settings are within expected ranges per function type      | Info     |
| **ECS Task Definition** | Fargate CPU/memory configurations are consistent across similar services | Warning  |
| **DynamoDB Capacity**   | All tables use on-demand mode (unless explicitly provisioned)            | Warning  |
| **S3 Encryption**       | All buckets have server-side encryption enabled                          | Error    |
| **S3 Public Access**    | No buckets have unintended public access                                 | Critical |
| **CloudFront HTTPS**    | All distributions enforce HTTPS                                          | Error    |
| **Security Groups**     | No overly permissive inbound rules (0.0.0.0/0 on non-HTTP ports)         | Critical |
| **Tag Compliance**      | All resources have mandatory tags                                        | Error    |
| **Backup Status**       | DynamoDB point-in-time recovery is enabled                               | Warning  |
| **Log Retention**       | CloudWatch log groups have retention policies (not infinite)             | Warning  |
| **Secret Rotation**     | Secrets Manager secrets have rotation enabled                            | Warning  |
| **SSL Certificates**    | ACM certificates are not expiring within 30 days                         | Critical |

### 8.3 Drift Detection

Beyond static rules, detect when resources change unexpectedly:

- **CloudFormation Drift Detection** — Are deployed resources matching their templates?
- **AWS Config Change Timeline** — What changed on resource X and when?
- **Manifest vs. Reality** — Does the project's `.futurator/manifest.json` match actual deployed resources?

### Discussion points:

- Should audit failures block deployments or just generate warnings?
- How do we handle legitimate exceptions to naming conventions?
- What's the right audit frequency? Hourly? Daily?
- Should audit results feed into a "project health score"?

---

## 9. Docker & Container Strategy

### 9.1 Current Container Architecture

All backend services run on **ECS Fargate** with Docker images stored in **ECR**. The typical pattern:

```
Developer pushes to GitHub
  → GitHub Actions builds Docker image
  → Pushes to ECR (eu-central-1)
  → Updates ECS Task Definition
  → ECS Service performs rolling deployment
```

### 9.2 Docker Image Standards

**Base images (standardise across all projects):**

| Purpose           | Base Image               | Notes                                     |
| ----------------- | ------------------------ | ----------------------------------------- |
| Node.js API       | `node:20-alpine`         | Smallest footprint, pin to specific patch |
| Python API        | `python:3.12-slim`       | For ML/audio services (Songster, GoMAD)   |
| Multi-stage build | Builder + runtime stages | Keep final images < 200MB                 |

**Dockerfile standards for all projects:**

```dockerfile
# Standard Futurator Dockerfile pattern
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 -S appuser && adduser -S appuser -u 1001
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

**Mandatory Docker practices:**

- Multi-stage builds (separate build and runtime stages)
- Non-root user (`appuser`)
- Health check endpoint (`/health`)
- `.dockerignore` including `node_modules`, `.git`, `.env`, `*.md`
- Pin base image versions (e.g., `node:20.12.2-alpine`, not `node:latest`)
- Vulnerability scanning via ECR native scanning or Trivy in GitHub Actions

### 9.3 ECR Repository Strategy

**Option A: One repository per project**

```
futurator-contento-api
futurator-sellebra-api
futurator-mbe-api
futurator-gomad-api
...
```

**Option B: One repository per service** (if projects have multiple containers)

```
futurator-contento-api
futurator-contento-worker
futurator-gomad-api
futurator-gomad-tts
futurator-songster-api
futurator-songster-audio-processor
...
```

**ECR Lifecycle Policies:**

```json
{
  "rules": [
    {
      "description": "Keep last 10 tagged images",
      "selection": { "tagStatus": "tagged", "countType": "imageCountMoreThan", "countNumber": 10 },
      "action": { "type": "expire" }
    },
    {
      "description": "Remove untagged images after 1 day",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 1
      },
      "action": { "type": "expire" }
    }
  ]
}
```

### 9.4 ECS Fargate Configuration Standards

| Parameter                  | Standard                                    | Notes                                  |
| -------------------------- | ------------------------------------------- | -------------------------------------- |
| CPU                        | 256 (0.25 vCPU) for APIs, 1024+ for workers | Right-size based on CloudWatch metrics |
| Memory                     | 512 MB for APIs, 2048+ for workers          | Must be compatible with CPU selection  |
| Desired count              | 1 (staging), 2+ (production)                | Auto-scaling for production            |
| Health check grace period  | 60 seconds                                  | Allow container startup time           |
| Deployment circuit breaker | Enabled with rollback                       | Prevent broken deploys from completing |
| Logging                    | awslogs driver → CloudWatch                 | Standardised log group naming          |
| Secrets                    | From Secrets Manager / SSM Parameter Store  | Never bake secrets into images         |

### 9.5 Container Insights for Admin Hub

The Admin Hub should display per-project container metrics:

- **Task count** — Running/pending/stopped tasks per service
- **CPU/Memory utilisation** — Average and peak per service
- **Image age** — When was the latest image pushed? Flag stale deployments.
- **Image size** — Track bloat over time
- **Vulnerability scan results** — Critical/high/medium findings per image
- **Deployment history** — Last 10 deployments with timestamps and commit SHAs
- **Cost per container** — Fargate pricing = (vCPU hours × $0.04048) + (GB hours × $0.004445)

### Discussion points:

- Should we adopt a shared ECS cluster across projects or one cluster per project?
- Are there any projects that would benefit from Graviton (ARM) processors? (20% cheaper on Fargate)
- Should we implement container image signing (AWS Signer)?
- What's the right auto-scaling strategy for each project?

---

## 10. GitHub Architecture & Actions Pipeline

### 10.1 Repository Structure

**Current state:** Each project has its own GitHub repository.

**Proposed organisation:**

```
github.com/futurator/
  ├── contento/              # App: Contento web builder
  ├── sellebra/              # App: Sellebra e-commerce
  ├── mbe/                   # App: MBE architectural platform
  ├── applicator/            # App: MyApplicator CV engine
  ├── gomad/                 # App: GoMAD debate engine
  ├── atlassinator/          # App: Atlassinator
  ├── dasher/                # App: Dasher dashboards
  ├── songster/              # App: Songster music tool
  ├── mycelium/              # App: Mycelium project management
  ├── admin-hub/             # App: This project (Futurator Admin Hub)
  ├── identity-broker/       # Microservice: Centralised auth
  ├── futurator-boilerplate/ # Template: New project starter
  ├── futurator-cdk/         # Shared: CDK constructs library
  ├── futurator-ui/          # Shared: React component library
  ├── futurator-claude-skills/ # Shared: Claude Code skills
  └── .github/               # Org-level: GitHub Actions workflows, templates
```

### 10.2 GitHub Actions — Standard Pipeline

Every project repository should have these workflow files:

**`.github/workflows/ci.yml`** — Runs on every PR:

```yaml
name: CI
on:
  pull_request:
    branches: [main, develop]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint # ESLint
      - run: npm run format:check # Prettier
      - run: npm run knip # Dead code detection
      - run: npm run typecheck # TypeScript
      - run: npm run test # Unit tests
      - run: npm run build # Verify build succeeds

  validate-manifest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate .futurator/manifest.json
        run: |
          node scripts/validate-manifest.js
          # Checks: required fields present, valid project ID, features list non-empty

  tag-compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify CDK tags
        run: |
          npx cdk synth --quiet
          node scripts/check-tags-in-template.js cdk.out/*.template.json

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          severity: 'CRITICAL,HIGH'
```

**`.github/workflows/deploy.yml`** — Runs on push to main:

```yaml
name: Deploy
on:
  push:
    branches: [main]

env:
  AWS_REGION: eu-central-1
  ECR_REPOSITORY: futurator-${{ github.event.repository.name }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::role/github-actions-deploy
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, push Docker image
        run: |
          docker build -t $ECR_REPOSITORY:${{ github.sha }} .
          docker tag $ECR_REPOSITORY:${{ github.sha }} $ECR_REGISTRY/$ECR_REPOSITORY:latest
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:${{ github.sha }}
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest

      - name: Deploy to ECS
        run: |
          aws ecs update-service \
            --cluster futurator-cluster \
            --service ${{ github.event.repository.name }} \
            --force-new-deployment

      - name: Notify Admin Hub
        run: |
          curl -X POST https://api.futurator.ai/admin/webhooks/deploy \
            -H "Authorization: Bearer ${{ secrets.ADMIN_HUB_TOKEN }}" \
            -d '{
              "project": "${{ github.event.repository.name }}",
              "commit": "${{ github.sha }}",
              "timestamp": "${{ github.event.head_commit.timestamp }}",
              "author": "${{ github.event.head_commit.author.name }}"
            }'

  sync-manifest:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Push manifest to Admin Hub
        run: |
          curl -X PUT https://api.futurator.ai/admin/projects/${{ github.event.repository.name }}/manifest \
            -H "Authorization: Bearer ${{ secrets.ADMIN_HUB_TOKEN }}" \
            -d @.futurator/manifest.json
```

### 10.3 GitHub API Integration for Admin Hub

The Admin Hub pulls data from GitHub to maintain the project registry:

| Data Point                   | GitHub API Endpoint                    | Frequency  |
| ---------------------------- | -------------------------------------- | ---------- |
| Repository list              | `GET /orgs/futurator/repos`            | Daily      |
| Last commit per repo         | `GET /repos/{repo}/commits?per_page=1` | Hourly     |
| Open PRs                     | `GET /repos/{repo}/pulls?state=open`   | Hourly     |
| Workflow runs (CI/CD status) | `GET /repos/{repo}/actions/runs`       | On webhook |
| Contributors                 | `GET /repos/{repo}/contributors`       | Weekly     |
| Languages/LOC                | `GET /repos/{repo}/languages`          | Weekly     |
| Releases/tags                | `GET /repos/{repo}/releases`           | On webhook |

**GitHub Webhooks → Admin Hub:**

- `push` → Update project registry, trigger manifest sync
- `workflow_run` → Update CI/CD status
- `release` → Update version info
- `pull_request` → Track active development

### 10.4 GitHub Actions Usage Monitoring

GitHub Actions minutes have costs. The Admin Hub should track:

- Minutes used per project per month
- Which workflows consume the most time
- Cache hit rates (are we caching `node_modules` effectively?)
- Failed workflow ratio

GitHub API: `GET /orgs/futurator/settings/billing/actions`

### Discussion points:

- Should we use GitHub Actions or AWS CodePipeline for deployment?
- Should we adopt a monorepo (Turborepo) instead of multi-repo?
- How do we handle secrets rotation across all project repositories?
- Should we use GitHub Environments for staging vs. production deploy approvals?

---

## 11. New Project Bootstrap — The Futurator Boilerplate

### 11.1 The Problem

Starting a new project currently requires:

1. Create GitHub repo manually
2. Copy boilerplate from an existing project (inheriting its debt)
3. Set up CI/CD pipeline from scratch
4. Configure AWS resources manually
5. Integrate Identity Broker
6. Set up linting, formatting, type checking
7. Create BMAD agent configuration
8. Configure Claude skills
9. Deploy initial infrastructure

**Goal:** Reduce this from 2–3 days to 15–30 minutes via a standardised boilerplate + CLI/Admin Hub wizard.

### 11.2 Boilerplate Repository Structure

```
futurator-boilerplate/
├── .futurator/
│   ├── manifest.json              # Project metadata (filled during init)
│   └── config.yaml                # Futurator ecosystem config
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # Standard CI pipeline
│   │   ├── deploy-staging.yml     # Deploy to staging
│   │   ├── deploy-production.yml  # Deploy to production
│   │   └── manifest-sync.yml     # Sync manifest to Admin Hub
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   ├── feature_request.md
│   │   └── task.md
│   └── dependabot.yml             # Automated dependency updates
│
├── .bmad/                         # BMAD Agent Method
│   ├── agents/
│   │   ├── analyst.md             # Business Analyst agent
│   │   ├── architect.md           # Solution Architect agent (Bedrock)
│   │   ├── designer.md            # UX/UI Designer agent
│   │   ├── dev.md                 # Developer agent
│   │   ├── pm.md                  # Project Manager agent
│   │   ├── po.md                  # Product Owner agent
│   │   └── qa.md                  # QA agent
│   ├── tasks/
│   │   ├── create-prd.md          # Product Requirements Document task
│   │   ├── create-architecture.md # Architecture document task
│   │   ├── create-story.md        # User story task
│   │   └── create-next-story.md   # Next iteration task
│   ├── templates/
│   │   ├── prd-template.md
│   │   ├── architecture-template.md
│   │   ├── story-template.md
│   │   └── front-end-architecture-template.md
│   ├── checklists/
│   │   ├── story-draft-checklist.md
│   │   ├── architecture-checklist.md
│   │   └── change-checklist.md
│   └── personas/
│       ├── bedrock.md             # Infrastructure persona
│       ├── nimbus.md              # Cloud services persona
│       ├── docker-harbor.md       # Container persona
│       └── rick.md                # Innovation Disruptor persona
│
├── .claude/                       # Claude Code Skills
│   ├── skills/
│   │   ├── code-standards.md      # Futurator coding conventions
│   │   ├── deployment-guide.md    # How to deploy Futurator apps
│   │   ├── chat-orchestration.md  # AI chat/LLM orchestration patterns
│   │   ├── frontend-components.md # Shared React component patterns
│   │   ├── dynamodb-patterns.md   # Single-table design patterns
│   │   ├── error-handling.md      # Standardised error handling
│   │   ├── testing-strategy.md    # Testing conventions
│   │   ├── api-design.md          # API Gateway endpoint patterns
│   │   └── security.md            # Security practices
│   └── settings.json              # Claude Code project settings
│
├── infrastructure/                # AWS CDK
│   ├── bin/
│   │   └── app.ts                 # CDK app entry point
│   ├── lib/
│   │   ├── stacks/
│   │   │   ├── network-stack.ts   # VPC, security groups
│   │   │   ├── storage-stack.ts   # DynamoDB, S3
│   │   │   ├── compute-stack.ts   # ECS Fargate, Lambda
│   │   │   ├── api-stack.ts       # API Gateway
│   │   │   └── cdn-stack.ts       # CloudFront
│   │   ├── constructs/
│   │   │   ├── futurator-fargate-service.ts  # Standard ECS service construct
│   │   │   ├── futurator-dynamodb-table.ts   # Standard DynamoDB construct
│   │   │   ├── futurator-lambda.ts           # Standard Lambda construct
│   │   │   └── futurator-s3-bucket.ts        # Standard S3 construct
│   │   └── aspects/
│   │       ├── tagging-aspect.ts  # Auto-apply futurator tags
│   │       └── security-aspect.ts # Enforce encryption, HTTPS
│   ├── cdk.json
│   └── tsconfig.json
│
├── backend/                       # Backend API
│   ├── src/
│   │   ├── handlers/              # Lambda handlers or Express routes
│   │   ├── services/              # Business logic
│   │   ├── repositories/          # DynamoDB data access
│   │   ├── middleware/
│   │   │   ├── auth.ts            # Identity Broker token validation
│   │   │   ├── error-handler.ts   # Standardised error handling
│   │   │   └── logger.ts          # Structured logging
│   │   ├── types/                 # TypeScript types
│   │   └── utils/                 # Shared utilities
│   ├── Dockerfile                 # Standard multi-stage Dockerfile
│   ├── .dockerignore
│   ├── tsconfig.json
│   └── package.json
│
├── frontend/                      # React/TypeScript Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/            # Shell, sidebar, header
│   │   │   ├── auth/              # Login, protected routes
│   │   │   └── shared/            # Reusable components
│   │   ├── hooks/
│   │   │   ├── useAuth.ts         # Identity Broker hook
│   │   │   └── useApi.ts          # API client hook
│   │   ├── pages/                 # Route-level components
│   │   ├── services/              # API client services
│   │   ├── stores/                # Zustand stores
│   │   ├── types/                 # TypeScript types
│   │   └── utils/
│   ├── public/
│   ├── index.html
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── package.json
│
├── scripts/
│   ├── init-project.sh            # Interactive project initialisation
│   ├── validate-manifest.js       # Manifest validation for CI
│   ├── check-tags-in-template.js  # CDK tag compliance checker
│   └── seed-data.sh               # DynamoDB seed data for development
│
├── .eslintrc.cjs                  # ESLint configuration
├── .prettierrc                    # Prettier configuration
├── knip.config.ts                 # Knip (dead code detection) config
├── tsconfig.base.json             # Shared TypeScript config
├── docker-compose.yml             # Local development environment
├── .env.example                   # Environment variable template
├── .gitignore
├── LICENSE
└── README.md
```

### 11.3 Initialisation Script (`init-project.sh`)

When creating a new project, a developer runs:

```bash
npx create-futurator-app my-new-project
```

or from the Admin Hub UI (MVP3), which triggers the same process via GitHub API.

The initialisation script:

1. Prompts for project metadata (name, description, category, AWS services needed)
2. Generates `.futurator/manifest.json` with provided data
3. Configures CDK stacks based on selected AWS services
4. Sets up GitHub repository via GitHub API
5. Configures GitHub Actions secrets (AWS credentials, Admin Hub token)
6. Creates ECR repository
7. Deploys initial infrastructure via CDK
8. Registers project in Admin Hub
9. Configures Identity Broker for the new project
10. Runs initial CI pipeline

### 11.4 Manifest File Schema

Every project must have `.futurator/manifest.json`:

```json
{
  "$schema": "https://futurator.ai/schemas/manifest.v1.json",
  "project": {
    "id": "contento",
    "name": "Contento",
    "category": "independent-companies",
    "status": "beta",
    "brief": "AI-based web builder for small entrepreneurs",
    "description": "Full extended description...",
    "repository": "github.com/futurator/contento",
    "url": "https://futurator.ai/projects/contento",
    "team": ["richie"],
    "created": "2025-09-15",
    "updated": "2026-04-02"
  },
  "features": [
    {
      "id": "headless-cms",
      "name": "Headless CMS",
      "status": "active",
      "awsServices": ["dynamodb", "s3", "lambda", "bedrock"],
      "description": "AI-powered headless content management system"
    },
    {
      "id": "booking-system",
      "name": "Booking System",
      "status": "active",
      "awsServices": ["dynamodb", "lambda", "ses"],
      "description": "Client booking and scheduling"
    }
  ],
  "infrastructure": {
    "region": "eu-central-1",
    "account": "123456789012",
    "services": {
      "ecs": {
        "cluster": "futurator-cluster",
        "services": ["contento-api"],
        "taskCpu": 256,
        "taskMemory": 512
      },
      "dynamodb": {
        "tables": ["contento-prod-main", "contento-prod-sessions"]
      },
      "s3": {
        "buckets": ["futurator-contento-assets-prod", "futurator-contento-uploads-prod"]
      },
      "lambda": {
        "functions": ["contento-image-processor", "contento-newsletter-sender"]
      }
    }
  },
  "clients": [
    {
      "id": "5seasons",
      "name": "5Seasons",
      "status": "beta-testing",
      "domain": "5seasons.example.com"
    }
  ],
  "dependencies": {
    "shared": ["identity-broker"],
    "external": ["google-maps-api", "stripe"]
  }
}
```

### 11.5 Standard Tooling Configuration

**ESLint (`.eslintrc.cjs`):**

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'import', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'prettier', // Must be last — disables formatting rules
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
      },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
```

**Prettier (`.prettierrc`):**

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

**Knip (`knip.config.ts`):**

```typescript
export default {
  entry: ['src/index.ts', 'src/**/*.handler.ts'],
  project: ['src/**/*.ts'],
  ignore: ['**/*.test.ts', '**/*.spec.ts'],
  ignoreDependencies: ['@types/*'],
};
```

### Discussion points:

- Should the boilerplate be a GitHub template repository or a CLI tool (like create-react-app)?
- Should shared CDK constructs live in the boilerplate or in a separate `futurator-cdk` package?
- How do we handle boilerplate updates propagating to existing projects?
- Should we use Turborepo monorepo instead of multi-repo?

---

## 12. BMAD Method Integration

### 12.1 What is BMAD?

The **BMAD (Breakthrough Method of Agile AI-Driven Development)** method is an AI-native development methodology that structures project work through specialised AI agent personas. Each agent has a defined role, set of tasks, templates, and checklists.

### 12.2 Standard Agent Squad

Every Futurator project comes with these pre-configured agents:

| Agent                   | Role                                           | Key Outputs                                          |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| **Analyst**             | Business analysis, requirements gathering      | PRDs, user research, market analysis                 |
| **Architect (Bedrock)** | Solution architecture, AWS design              | Architecture docs, infrastructure plans, CDK designs |
| **Designer**            | UX/UI design, frontend architecture            | Wireframes, design systems, component specs          |
| **Developer (Dev)**     | Implementation, code generation                | Code, tests, documentation                           |
| **PM**                  | Project planning, sprint management            | Sprint plans, timelines, risk assessments            |
| **PO (Product Owner)**  | Feature prioritisation, stakeholder management | Backlogs, acceptance criteria, roadmaps              |
| **QA**                  | Testing strategy, quality assurance            | Test plans, bug reports, quality metrics             |

### 12.3 Named Personas (Futurator-Specific)

Beyond generic roles, Futurator uses named personas with distinct perspectives:

| Persona                           | Role                      | Personality                                                                        |
| --------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| **Bedrock**                       | Infrastructure Guardian   | Conservative, security-first, cost-conscious                                       |
| **Nimbus**                        | Cloud Services Strategist | Optimistic about managed services, scalability-focused                             |
| **Docker Harbor**                 | Container Specialist      | Efficiency-obsessed, image-size-aware, deployment-savvy                            |
| **Rick the Innovation Disruptor** | Creative Challenger       | Questions assumptions, proposes radical alternatives, breaks conventional thinking |

### 12.4 BMAD in the Admin Hub

The Admin Hub should track:

- Which BMAD agents are configured per project
- PRD and architecture document status per project
- Active stories and their completion status
- Which persona provided input on architectural decisions

### Discussion points:

- Should BMAD configurations be standardised across all projects or customisable per project?
- Should the Admin Hub have a BMAD dashboard showing documentation health per project?
- How do we version-control BMAD templates and propagate improvements?

---

## 13. Claude Skills & Code Standards

### 13.1 Shared Claude Skills Library

All projects share a common set of Claude Code skills that encode Futurator development standards. These live in `.claude/skills/` in each project (synced from `futurator-claude-skills` repo).

### 13.2 Skill Definitions

**`code-standards.md`** — Futurator Coding Conventions:

- TypeScript strict mode everywhere
- Functional React components with hooks (no class components)
- Zustand for state management (not Redux)
- Single-table DynamoDB design with documented access patterns
- Structured logging (JSON format) with correlation IDs
- Error codes prefixed with project ID (e.g., `CONTENTO-001`)
- API responses follow standard envelope: `{ data, error, meta }`
- All dates in ISO 8601 UTC
- Environment variables prefixed: `FUTURATOR_{PROJECT}_{KEY}`

**`deployment-guide.md`** — How to Deploy:

- Staging deploys on push to `develop` branch
- Production deploys on push to `main` branch
- Zero-downtime rolling deployments via ECS
- Database migrations run as separate Lambda before deploy
- Rollback procedure: revert to previous ECS task definition

**`chat-orchestration.md`** — AI Chat/LLM Patterns:

- All LLM calls go through a shared orchestration layer
- System prompts are versioned and stored in DynamoDB
- Token usage is tracked per user, per project
- Streaming responses via Server-Sent Events (SSE)
- Fallback chain: Bedrock Claude → direct Anthropic API → graceful degradation
- Rate limiting per user tier

**`frontend-components.md`** — React Component Patterns:

- Component file structure: `Component.tsx`, `Component.test.tsx`, `index.ts`
- Use Tailwind CSS utility classes (no CSS modules)
- Headless UI patterns (logic separated from presentation)
- Loading states via Suspense boundaries
- Error boundaries at route level
- Responsive design: mobile-first approach

**`dynamodb-patterns.md`** — DynamoDB Design Standards:

- Single-table design per project
- Partition key: `PK` (string), Sort key: `SK` (string)
- Entity type stored in `_type` attribute
- GSI1: `GSI1PK`, `GSI1SK` for inverted access patterns
- TTL attribute: `_ttl` (epoch seconds)
- Versioning attribute: `_version` (optimistic locking)
- All table names: `{project}-{environment}-{purpose}`

**`error-handling.md`** — Standardised Error Handling:

- Custom error classes extending base `FuturatorError`
- Error codes: `{PROJECT}-{CATEGORY}-{NUMBER}` (e.g., `GOMAD-AUTH-001`)
- All errors logged with stack traces in structured JSON
- API errors return: `{ error: { code, message, details } }`
- Never expose internal errors to clients

**`api-design.md`** — API Gateway Patterns:

- RESTful endpoints: `/{project}/v1/{resource}`
- Auth: Bearer token from Identity Broker
- Pagination: cursor-based with `?cursor=xxx&limit=20`
- Filtering: query parameters with `?filter[field]=value`
- Sorting: `?sort=-created_at` (prefix `-` for descending)
- Rate limiting: per-user via API Gateway usage plans

**`security.md`** — Security Practices:

- All data encrypted at rest (DynamoDB, S3, EBS)
- All data encrypted in transit (HTTPS everywhere)
- IAM least-privilege: each Lambda/ECS task has its own role
- Secrets in AWS Secrets Manager (never environment variables)
- Input validation on all API endpoints
- CORS configured per project (no wildcard origins in production)
- Content Security Policy headers on all frontend responses

### 13.3 Keeping Skills in Sync

When a skill is updated in the `futurator-claude-skills` repo, a GitHub Action can:

1. Open PRs against all project repos with the updated skill files
2. Or use a git submodule / npm package approach for centralised distribution

### Discussion points:

- Should Claude skills be a git submodule, an npm package, or copied files?
- How do we handle project-specific skill overrides?
- Should there be a skill for "how to use the Admin Hub API"?
- Which skills are most critical to standardise first?

---

## 14. Identity Broker & Authentication Flow

### 14.1 Architecture Overview

The Identity Broker is a centralised authentication microservice that all Futurator projects share. It wraps AWS Cognito and provides:

- Single sign-on across all Futurator apps
- User pool management
- Token issuance and validation
- Role-based access control (RBAC)
- Multi-tenant support (user ↔ app ↔ role mapping)

### 14.2 Authentication Flow for New Projects

When a new project is bootstrapped, the Identity Broker integration requires:

1. **Register app in Identity Broker** — Create an app client in the shared Cognito User Pool
2. **Configure redirect URIs** — Add the new project's callback URLs
3. **Define roles** — Map project-specific roles (e.g., `contento:admin`, `contento:editor`, `contento:viewer`)
4. **Frontend integration** — Use the shared `useAuth` hook from `futurator-ui`
5. **Backend integration** — Use the shared auth middleware that validates Identity Broker tokens

### 14.3 Token Structure

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "futurator:projects": {
    "contento": { "role": "admin", "tenants": ["5seasons", "winesisters"] },
    "gomad": { "role": "user" },
    "admin-hub": { "role": "admin" }
  },
  "iss": "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_XXXXX",
  "exp": 1717200000
}
```

### 14.4 Admin Hub Integration (MVP2)

The Admin Hub will provide:

- **User directory** — All users across all projects
- **Per-project user counts** — Active users, last login, usage patterns
- **Access management** — Grant/revoke project access from the Admin Hub
- **Audit log** — Login events, role changes, suspicious activity
- **Session management** — View active sessions, force logout

### 14.5 Standard Login Component

The boilerplate includes a pre-built login flow:

```typescript
// frontend/src/components/auth/LoginPage.tsx
import { useAuth } from '@futurator/ui';

export function LoginPage() {
  const { login, isLoading } = useAuth({
    identityBrokerUrl: process.env.FUTURATOR_IDENTITY_BROKER_URL,
    appClientId: process.env.FUTURATOR_APP_CLIENT_ID,
    redirectUri: window.location.origin + '/callback',
  });

  // ... renders Futurator-branded login page
}
```

### Discussion points:

- Should we support social login (Google, GitHub) via Cognito federation?
- How do we handle client-specific users in multi-tenant apps (e.g., 5Seasons staff)?
- Should the Identity Broker issue short-lived tokens with refresh rotation?
- How do we migrate existing project-specific Cognito pools to the shared broker?

---

## 15. Admin Hub Technical Architecture

### 15.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  futurator.ai/admin (React/TypeScript SPA)                  │
│  ├── Project Registry Dashboard                             │
│  ├── AWS Cost Dashboard                                     │
│  ├── Resource Map & Auditor                                 │
│  ├── Identity Dashboard (MVP2)                              │
│  └── Resource Scheduler (MVP2)                              │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTPS
┌──────────────▼──────────────────────────────────────────────┐
│  API Gateway (futurator.ai/admin/api)                       │
│  ├── GET /projects                                          │
│  ├── GET /projects/{id}                                     │
│  ├── GET /projects/{id}/costs                               │
│  ├── GET /projects/{id}/resources                           │
│  ├── GET /costs/overview                                    │
│  ├── GET /audits/latest                                     │
│  ├── POST /webhooks/deploy (from GitHub)                    │
│  ├── POST /webhooks/alert (from CloudWatch/Budgets)         │
│  ├── PUT /projects/{id}/manifest                            │
│  └── POST /scheduler/actions (MVP2)                         │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  Lambda Functions                                            │
│  ├── api-handler (Express/Fastify on Lambda)                │
│  ├── cost-aggregator (scheduled daily)                      │
│  ├── resource-discoverer (scheduled daily)                  │
│  ├── consistency-auditor (scheduled daily)                  │
│  ├── manifest-syncer (webhook-triggered)                    │
│  ├── alert-processor (event-triggered)                      │
│  └── resource-scheduler (event-triggered, MVP2)             │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  DynamoDB (admin-hub-prod-main)                             │
│  ├── Project metadata, features, clients                    │
│  ├── Cost data (daily snapshots)                            │
│  ├── Resource inventory (daily snapshots)                   │
│  ├── Audit results                                          │
│  ├── Deployment history                                     │
│  └── User/session data (MVP2)                               │
└─────────────────────────────────────────────────────────────┘

External data sources:
  ← AWS Cost Explorer API
  ← AWS Resource Groups Tagging API
  ← AWS Config
  ← AWS CloudWatch
  ← GitHub API v4
  ← Identity Broker (Cognito Admin API)
  ← External provider APIs (ElevenLabs, etc.)
```

### 15.2 Technology Choices

| Layer      | Technology                                                | Rationale                                    |
| ---------- | --------------------------------------------------------- | -------------------------------------------- |
| Frontend   | React + TypeScript + Vite + Tailwind + Zustand + Recharts | Consistent with all Futurator projects       |
| API        | Lambda + API Gateway (HTTP API)                           | Serverless, cost-effective for internal tool |
| Database   | DynamoDB (single-table)                                   | Consistent with all Futurator projects       |
| IaC        | CDK (TypeScript)                                          | Consistent with all Futurator projects       |
| Auth       | Identity Broker (Cognito)                                 | Dog-fooding our own auth                     |
| Monitoring | CloudWatch + X-Ray                                        | Native AWS observability                     |
| CI/CD      | GitHub Actions                                            | Consistent with all Futurator projects       |

### 15.3 Why Lambda over ECS for the Admin Hub?

The Admin Hub is an internal tool with low, bursty traffic (a few users, occasional dashboard loads). Lambda is more cost-effective than an always-running ECS Fargate task. The scheduled aggregation Lambdas run once daily and complete in seconds.

If the Admin Hub grows to serve many users or needs persistent connections (WebSockets for real-time updates), we can migrate the API to ECS Fargate later.

---

## 16. DynamoDB Schema Design

### 16.1 Single Table — `admin-hub-prod-main`

| PK               | SK                              | Description                                                      |
| ---------------- | ------------------------------- | ---------------------------------------------------------------- |
| `PROJECT#{id}`   | `META`                          | Project metadata (brief, extended, status, github_url, category) |
| `PROJECT#{id}`   | `FEATURE#{feature-id}`          | Individual feature definition                                    |
| `PROJECT#{id}`   | `CLIENT#{client-id}`            | Client information (for multi-tenant projects)                   |
| `PROJECT#{id}`   | `AWS#{service}#{resource-name}` | Discovered AWS resource                                          |
| `PROJECT#{id}`   | `COST#{YYYY-MM-DD}`             | Daily cost snapshot                                              |
| `PROJECT#{id}`   | `COST#MONTHLY#{YYYY-MM}`        | Monthly cost summary                                             |
| `PROJECT#{id}`   | `DEPLOY#{timestamp}`            | Deployment record                                                |
| `PROJECT#{id}`   | `AUDIT#{timestamp}`             | Audit result snapshot                                            |
| `PROJECT#{id}`   | `MANIFEST#{version}`            | Manifest version history                                         |
| `COST#PORTFOLIO` | `{YYYY-MM-DD}`                  | Portfolio-wide daily cost                                        |
| `AUDIT#GLOBAL`   | `{timestamp}`                   | Global audit results                                             |
| `USER#{user-id}` | `META`                          | User metadata (MVP2)                                             |
| `USER#{user-id}` | `SESSION#{project-id}`          | User session per project (MVP2)                                  |
| `SCHEDULE#{id}`  | `META`                          | Resource schedule definition (MVP2)                              |

### 16.2 GSIs

| GSI  | PK                   | SK                 | Purpose                                                                |
| ---- | -------------------- | ------------------ | ---------------------------------------------------------------------- |
| GSI1 | `SK`                 | `PK`               | Inverted lookup (e.g., find all projects using a specific AWS service) |
| GSI2 | `_type`              | `_updated`         | Query by entity type, sorted by recency                                |
| GSI3 | `futurator:category` | `futurator:status` | Filter projects by category and status                                 |

---

## 17. Living Documentation System

### 17.1 The Staleness Problem

Documentation goes stale because it's disconnected from the codebase. The Futurator solution: documentation is either auto-generated from code/infrastructure or stored in the `.futurator/manifest.json` which is validated on every push.

### 17.2 Documentation Layers

| Layer                  | Source                             | Update Trigger         | Storage            |
| ---------------------- | ---------------------------------- | ---------------------- | ------------------ |
| Project brief          | `.futurator/manifest.json`         | Git push               | Admin Hub DynamoDB |
| Feature list           | `.futurator/manifest.json`         | Git push               | Admin Hub DynamoDB |
| AWS resource inventory | AWS Config + Tagging API           | Daily scheduled Lambda | Admin Hub DynamoDB |
| Architecture diagram   | Auto-generated from CDK + manifest | On deploy              | S3 (SVG/PNG)       |
| API documentation      | OpenAPI spec in repo               | Git push               | Admin Hub + S3     |
| Cost data              | Cost Explorer API                  | Daily scheduled Lambda | Admin Hub DynamoDB |
| Deployment history     | GitHub Actions webhook             | On deploy              | Admin Hub DynamoDB |
| Dependency graph       | `package.json` + CDK analysis      | Git push               | Admin Hub DynamoDB |

### 17.3 AI-Assisted Documentation (MVP3)

Using Bedrock, the Admin Hub can:

1. Analyse a project's codebase and generate/update architecture documentation
2. Detect when code changes don't match the manifest (drift detection)
3. Suggest feature list updates based on new endpoints or UI routes
4. Generate changelogs from git history
5. Answer questions about any project's architecture in natural language

---

## 18. Cross-Project Service Matrix

### 18.1 Shared Service Patterns

Across all 9 projects, several patterns repeat. The Admin Hub should identify and standardise these:

| Pattern                    | Projects Using It                        | Standardisation Opportunity         |
| -------------------------- | ---------------------------------------- | ----------------------------------- |
| User authentication        | All (via Identity Broker)                | Shared Cognito middleware + hooks   |
| File upload → S3           | Contento, Sellebra, Applicator, Songster | Shared pre-signed URL Lambda        |
| DynamoDB single-table      | All                                      | Shared base repository class        |
| AI chat/completion         | 7 projects                               | Shared Bedrock orchestration layer  |
| Async job processing (SQS) | 4 projects                               | Shared SQS consumer pattern         |
| PDF generation             | Applicator, potentially Sellebra         | Shared PDF Lambda                   |
| Web scraping               | Applicator, GoMAD                        | Shared Playwright service           |
| Email sending              | Contento (newsletters), Applicator       | Shared SES service                  |
| TTS / audio processing     | GoMAD, Songster, Applicator              | Shared audio processing ECS service |
| Graph database (Memgraph)  | GoMAD, Mycelium                          | Shared EC2 Memgraph cluster         |

### 18.2 Shared Service Library Strategy

Extract common patterns into shared packages:

```
@futurator/auth         → Identity Broker client (frontend + backend)
@futurator/dynamodb     → Base repository, single-table utilities
@futurator/bedrock      → Bedrock client with streaming, token tracking, fallback
@futurator/s3           → File upload/download utilities
@futurator/sqs          → SQS consumer/producer patterns
@futurator/logger       → Structured logging with correlation IDs
@futurator/errors       → Standard error classes and codes
@futurator/ui           → Shared React components (login, layout, data tables)
```

---

## 19. Security & GDPR Considerations

### 19.1 GDPR Compliance

All Futurator projects are deployed in **eu-central-1** (Frankfurt) for GDPR compliance. The Admin Hub must maintain this standard:

- All data stored in EU regions only
- PII is encrypted at rest and in transit
- Right to deletion: ability to purge user data from all projects via Admin Hub
- Data processing records: the Admin Hub itself becomes a data processing registry
- Audit trails: CloudTrail + Admin Hub audit logs

### 19.2 Admin Hub Security

The Admin Hub has elevated access to all AWS resources. Security is critical:

- Access restricted to designated administrators only
- All actions logged in CloudTrail and Admin Hub audit table
- Read-only by default (MVP1). Write operations (MVP2) require additional confirmation.
- IAM role for Admin Hub Lambdas follows least-privilege: separate roles for cost reading, resource discovery, and resource management
- MFA required for Admin Hub login
- IP allowlisting option for production

### 19.3 Secrets Management

| Secret Type                | Storage                           | Rotation                |
| -------------------------- | --------------------------------- | ----------------------- |
| AWS credentials            | IAM Roles (no static credentials) | N/A (temporary via STS) |
| GitHub API token           | Secrets Manager                   | 90 days                 |
| Admin Hub internal API key | Secrets Manager                   | 30 days                 |
| External provider API keys | Secrets Manager                   | Per provider policy     |
| Cognito app client secrets | Secrets Manager                   | 180 days                |

---

## 20. Open Questions & Discussion Points

This section collects all discussion points from throughout the document, plus additional strategic questions.

### Architecture Decisions Needed

1. **Single AWS account vs. multi-account (AWS Organizations)?** Tags work in single-account but Organizations provides stronger isolation.
2. **Monorepo (Turborepo) vs. multi-repo?** Monorepo simplifies shared code but complicates per-project CI/CD.
3. **Lambda vs. ECS for the Admin Hub API?** Lambda is cheaper for low traffic but has cold start and 15-minute timeout limitations.
4. **CDK vs. Terraform vs. SAM?** Currently CDK — should this be the standard for all projects?
5. **Neptune vs. self-hosted Memgraph?** Neptune is managed but less flexible. Memgraph on EC2 is current.

### Operational Questions

6. **How aggressive should tag enforcement be?** Warning vs. blocking untagged resource creation.
7. **What's the right audit frequency?** Real-time is expensive; daily is practical.
8. **How do we handle shared resources in cost allocation?** Pro-rata by usage? Fixed split?
9. **Should the Admin Hub monitor itself?** Who watches the watchers?

### Product Questions

10. **Who are the users of the Admin Hub?** Just Richie? Future team members? Clients?
11. **Should clients have limited Admin Hub access?** E.g., 5Seasons seeing their own Contento costs.
12. **Should the Admin Hub expose a public status page?** Per-project health status.

### Development Questions

13. **Which project gets built first after the boilerplate is created?** Priority ordering?
14. **Should Claude skills be mandatory or advisory?** Can a project override a shared skill?
15. **How do we test the Admin Hub's AWS integrations locally?** LocalStack? Mocked responses?
16. **Should the init script create a development and staging environment by default?**

### Cost Questions

17. **What's the budget for the Admin Hub infrastructure itself?**
18. **At what portfolio cost threshold do Savings Plans become worth evaluating?**
19. **Should we set up AWS Cost Anomaly Detection immediately or wait for MVP1?**
20. **Should GitHub Actions minutes be tracked as infrastructure cost?**

---

## 21. Appendices

### Appendix A: AWS CLI Commands for Initial Resource Audit

```bash
# List all resources with futurator tags
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=futurator:project \
  --region eu-central-1

# Get monthly cost by project tag
aws ce get-cost-and-usage \
  --time-period Start=2026-03-01,End=2026-04-01 \
  --granularity MONTHLY \
  --group-by Type=TAG,Key=futurator:project \
  --metrics BlendedCost

# List all DynamoDB tables
aws dynamodb list-tables --region eu-central-1

# List all S3 buckets with tags
aws s3api list-buckets | jq -r '.Buckets[].Name' | while read bucket; do
  echo "=== $bucket ==="
  aws s3api get-bucket-tagging --bucket "$bucket" 2>/dev/null || echo "No tags"
done

# List all Lambda functions with runtime
aws lambda list-functions --region eu-central-1 \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime,Memory:MemorySize}' \
  --output table

# List all ECS services
aws ecs list-services --cluster futurator-cluster --region eu-central-1

# List all ECR repositories with image counts
aws ecr describe-repositories --region eu-central-1 \
  --query 'repositories[].{Name:repositoryName,URI:repositoryUri}'

# List all CloudFront distributions
aws cloudfront list-distributions \
  --query 'DistributionList.Items[].{Id:Id,Domain:DomainName,Status:Status}'

# Check untagged resources (compliance gap)
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name required-tags \
  --compliance-types NON_COMPLIANT \
  --region eu-central-1
```

### Appendix B: Cost Explorer API Example (Node.js)

```typescript
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

const client = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer is US-East-1 only

async function getProjectCosts(projectId: string, startDate: string, endDate: string) {
  const command = new GetCostAndUsageCommand({
    TimePeriod: { Start: startDate, End: endDate },
    Granularity: 'DAILY',
    Filter: {
      Tags: {
        Key: 'futurator:project',
        Values: [projectId],
      },
    },
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    Metrics: ['BlendedCost', 'UsageQuantity'],
  });

  const response = await client.send(command);
  return response.ResultsByTime;
}
```

### Appendix C: Resource Tagging API Example (Node.js)

```typescript
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

const client = new ResourceGroupsTaggingAPIClient({ region: 'eu-central-1' });

async function getProjectResources(projectId: string) {
  const command = new GetResourcesCommand({
    TagFilters: [{ Key: 'futurator:project', Values: [projectId] }],
  });

  const response = await client.send(command);
  return response.ResourceTagMappingList?.map((r) => ({
    arn: r.ResourceARN,
    tags: Object.fromEntries(r.Tags?.map((t) => [t.Key, t.Value]) || []),
  }));
}
```

### Appendix D: Further Reading & References

- [AWS Cost Explorer API Documentation](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html)
- [AWS Budgets API Documentation](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_Operations_AWS_Budgets.html)
- [AWS Resource Groups Tagging API](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/)
- [AWS Config Developer Guide](https://docs.aws.amazon.com/config/latest/developerguide/)
- [AWS CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [GitHub Actions for AWS](https://github.com/aws-actions)
- [ECS Fargate Pricing Calculator](https://aws.amazon.com/fargate/pricing/)
- [DynamoDB Single-Table Design](https://www.alexdebrie.com/posts/dynamodb-single-table-design/)

---

**Next Steps:**

1. Schedule brainstorming session with all stakeholders
2. Run initial AWS resource audit (Appendix A commands)
3. Define and activate cost allocation tags in Billing console
4. Create the `futurator-boilerplate` repository structure
5. Prototype the cost aggregation Lambda
6. Design the Admin Hub frontend wireframes

---

_This document is a living draft. All sections are open for discussion, revision, and expansion. Please add comments, questions, and counter-proposals directly._
