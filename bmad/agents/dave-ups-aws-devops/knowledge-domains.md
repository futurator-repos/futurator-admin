# Dave ups! — Knowledge Domains

## CI/CD Services

- CodePipeline V2 (action execution pricing, GitHub App integration, pipeline types)
- CodeBuild (buildspec.yml, compute types, ARM builds, caching, Docker, test reports)
- CodeDeploy (appspec.yml, deployment groups, EC2/ECS/Lambda strategies, rollback)
- CodeCatalyst (unified platform, dev environments, blueprints, workflows)
- ECR (lifecycle policies, image scanning, cross-region replication, signing)
- CodeArtifact (npm/Maven/PyPI repository, upstream resolution)

## IaC Tools

- AWS CDK v2 (constructs L1-L3, CDK Pipelines, cdk-nag, assertions, integ-tests)
- CloudFormation (stacks, nested stacks, StackSets, change sets, drift detection, macros)
- cfn-guard (policy-as-code for CloudFormation)
- Terraform (providers, state, workspaces, modules, Sentinel/OPA, Spacelift)
- Pulumi (multi-language IaC, state management)
- SAM (Serverless Application Model, sam build/deploy/local)

## Configuration & Secrets

- SSM Parameter Store (hierarchy, SecureString, cross-account)
- Secrets Manager (rotation, RDS integration, resource policies, caching)
- AppConfig (feature flags, deployment strategies, validation)
- AWS Config (managed/custom rules, conformance packs, remediation, aggregator)

## Monitoring & Observability

- CloudWatch Metrics, Logs, Alarms, Dashboards, Logs Insights, Anomaly Detection
- CloudWatch Synthetics (canary scripts), Container Insights, Lambda Insights
- X-Ray (tracing, service map, groups, sampling, insights)
- CloudTrail (management events, data events, organization trail, log validation)
- EMF (Embedded Metric Format for structured metrics from logs)
- OpenSearch (log analytics, when to use vs CloudWatch Logs Insights)

## Incident & Resilience

- EventBridge (rules, cross-account, scheduler, pipes)
- SSM Automation (runbooks, step types, error handling, approvals)
- AWS FIS (experiment templates, actions, targets, stop conditions, Scenario Library)
- AWS Resilience Hub (resilience assessment, policy, recommendations)
- AWS Backup (vaults, plans, cross-region/account, Audit Manager)
- Elastic Disaster Recovery (DRS)

## Security Automation

- IAM (roles, policies, permission boundaries, cross-account assume-role)
- SCPs (deny patterns, OU-level restrictions)
- KMS (key policies, grants, cross-account, rotation)
- Security scanning: CodeGuru, Inspector, ECR scanning, Trivy, Snyk, Semgrep, Checkov
- GuardDuty, Security Hub, Inspector (awareness for automation integration)
