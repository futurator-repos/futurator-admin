# Nimbus — Knowledge Domains

## 1. Compute

- EC2 (instance families, placement groups, Spot/Reserved/On-Demand, Auto Scaling)
- Lambda (event-driven, cold starts, concurrency, limits, pricing)
- ECS + Fargate (container orchestration, task definitions, service discovery)
- EKS (Kubernetes on AWS, managed node groups vs Fargate)
- Elastic Beanstalk, AWS Batch, App Runner, Lightsail, Outposts

## 2. Storage

- S3 (storage classes, lifecycle, replication, versioning, encryption, access points)
- EBS (gp3/io2/st1/sc1, snapshots, multi-attach), EFS, FSx (Windows/Lustre/ONTAP/OpenZFS)
- Storage Gateway (File/Volume/Tape), Snow Family, S3 Glacier (archive tiers, Vault Lock)

## 3. Databases

- RDS (Multi-AZ, Read Replicas, Proxy), Aurora (Global Database, Serverless v2, Limitless)
- DynamoDB (partition design, GSI/LSI, DAX, Global Tables, Streams)
- ElastiCache (Redis vs Memcached), MemoryDB, Redshift (Spectrum, Serverless)
- Neptune, DocumentDB, Keyspaces, QLDB, OpenSearch
- Database selection framework (relational vs NoSQL vs graph vs time-series vs ledger)

## 4. Networking & Content Delivery

- VPC (subnets, route tables, gateways, flow logs), Transit Gateway, VPC Peering
- PrivateLink / VPC Endpoints, Direct Connect, Site-to-Site VPN
- Route 53 (routing policies, health checks, Resolver, DNS Firewall)
- CloudFront (CDN, Lambda@Edge, Functions), Global Accelerator
- API Gateway (REST, HTTP, WebSocket), ELB (ALB vs NLB vs GLB)

## 5. Security, Identity & Compliance (Architectural Level)

- IAM, IAM Identity Center, Cognito, Directory Service
- KMS, ACM, Secrets Manager vs SSM Parameter Store
- Security Hub, GuardDuty, Inspector, Macie (awareness)
- AWS Config, Audit Manager, WAF/Shield/Firewall Manager (awareness)
- CloudTrail (management/data events, organizational trail)

## 6. Application Integration

- SQS (Standard vs FIFO, DLQ), SNS (pub/sub, filtering), EventBridge (event bus, rules)
- Step Functions (Standard vs Express), AppSync (GraphQL), MQ (ActiveMQ/RabbitMQ)
- Integration pattern selection (event-driven vs queue-based vs orchestration)

## 7. Management & Governance

- Organizations, Control Tower, CloudFormation/CDK, Systems Manager
- CloudWatch (metrics, logs, alarms, Logs Insights, Container Insights)
- Config, Service Catalog, Trusted Advisor, License Manager
- Cost Explorer, Budgets, CUR, Compute Optimizer

## 8. Migration & Transfer

- Migration Hub, Application Migration Service, DMS + SCT
- DataSync, Transfer Family, Snow Family, 7Rs framework

## 9. Analytics

- Athena, Glue (ETL, Data Catalog), Kinesis (Streams, Firehose)
- MSK (managed Kafka), EMR, Redshift, QuickSight, Lake Formation, OpenSearch

## 10. Containers & Serverless Patterns

- ECS vs EKS, Fargate vs EC2, microservices patterns, ECR
- Serverless patterns (Lambda + API GW + DynamoDB, event-driven)
- When containers vs serverless vs EC2 decision framework

## 11. DR & Business Continuity

- DR strategy selection (RTO/RPO -> pattern), cross-region replication
- Elastic Disaster Recovery, AWS Backup, GameDay testing

## 12. Cost Optimization

- Pricing models, rightsizing, storage tiering, data transfer cost awareness
- FinOps practices (tagging, showback/chargeback, budget alerts)
