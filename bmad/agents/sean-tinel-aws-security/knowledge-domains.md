# Sean Tinel — Knowledge Domains

## Threat Detection Services

- GuardDuty (all protection plans, Extended Threat Detection, organization management, threat/IP lists)
- Security Hub CSPM (standards, controls, exposure correlation, near real-time analytics, OCSF)
- Inspector (EC2/ECR/Lambda scanning, SBOM, network reachability)
- Macie (S3 classification, custom identifiers, policy findings)
- Detective (behavior graphs, entity investigation, GuardDuty integration)
- IAM Access Analyzer (external access, unused access, policy validation, generation)

## Identity & Access

- IAM (policies, roles, permission boundaries, session policies, ABAC, condition keys)
- IAM Identity Center (organization instance, federation, SCIM, permission sets)
- Cognito (User Pools, Identity Pools, adaptive auth, custom auth flows)
- Verified Access (identity trust providers, device trust, Cedar policies, endpoints)
- Verified Permissions (Cedar policy engine, policy stores, authorization)
- STS (assume-role, session tags, external ID, GetCallerIdentity)
- Organizations (SCPs, RCPs, declarative policies, AI service opt-out)

## Network Security

- VPC (subnets, route tables, NAT Gateway, VPC endpoints, PrivateLink)
- Network Firewall (stateful/stateless rules, IDS/IPS, domain filtering)
- WAF (managed rules, custom rules, rate limiting, bot control, IP sets)
- Shield / Shield Advanced (DDoS protection, DRT, cost protection)
- CloudFront (OAC, headers, geo-restriction, field-level encryption)
- VPC Lattice (service network, auth policies, mTLS)
- Firewall Manager (centralized WAF/SG/NF policies)
- DNS Firewall (domain filtering)

## Data Protection

- KMS (symmetric/asymmetric keys, key policies, grants, multi-region, external key store)
- ACM (public certificates, DNS validation, auto-renewal)
- ACM Private CA (root/subordinate CA, certificate lifecycle, CRL/OCSP)
- S3 security (SSE-S3/SSE-KMS/SSE-C, bucket policies, Block Public Access, Object Lock, access points)
- CloudWatch Logs data protection (PII masking)
- Secrets Manager (rotation, cross-account, caching)

## Governance & Compliance

- AWS Organizations (OUs, SCPs, RCPs, delegated admin, service quotas)
- Control Tower (landing zone, mandatory/optional/custom controls, Account Factory)
- Config (recorder, rules, conformance packs, aggregator, remediation)
- Audit Manager (frameworks, evidence, assessment reports)
- CloudTrail (organization trail, data events, log validation, Lake)
- Security Hub CSPM standards (FSBP, CIS, PCI-DSS, NIST)

## Incident Response

- EventBridge (rules, cross-account, target Lambda/SNS/SSM)
- SSM Automation (runbooks for security remediation)
- Lambda (containment functions, enrichment, rotation)
- Step Functions (complex incident response orchestration)
- S3 Object Lock (evidence preservation)
- EBS Snapshots (forensic image capture)
