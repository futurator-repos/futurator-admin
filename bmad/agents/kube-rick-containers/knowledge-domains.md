# Kube Rick — Knowledge Domains

## Kubernetes / EKS

- EKS Auto Mode (managed Karpenter, ALB Controller, EBS CSI, CoreDNS off-cluster, Bottlerocket)
- Karpenter (NodePools, NodeClasses, consolidation, disruption budgets, Spot, Graviton, Capacity Reservations)
- Managed Node Groups (AL2023, Bottlerocket, launch templates)
- Fargate Profiles (serverless pods, namespace/label selectors)
- VPC CNI (prefix delegation, custom networking, warm pool, security groups for pods)
- Network Policies (Calico, VPC CNI network policy engine)
- RBAC (ClusterRoles, Roles, RoleBindings, service accounts, AWS auth ConfigMap, access entries)
- Pod Identity / IRSA (IAM role association, migration path)
- Add-ons ecosystem (CoreDNS, Metrics Server, ALB Controller, cert-manager, External DNS, External Secrets, OPA/Gatekeeper, Kyverno)
- Helm (charts, values, releases, atomic upgrades, GitOps integration)
- Gateway API and Ingress Controller patterns
- Workload types (Deployment, StatefulSet, DaemonSet, Job, CronJob, HPA, VPA, PDB)

## ECS & Fargate

- Task definitions (container defs, resource allocation, logging, secrets, health checks, sidecars)
- Services (deployment config, load balancing, auto scaling, service discovery)
- Capacity providers (Fargate, Fargate Spot, EC2 ASG)
- Fargate specifics (platform versions, ephemeral storage, security model, no privileged)
- Service discovery (Cloud Map, DNS-based)
- Deployment strategies (rolling, blue/green via CodeDeploy)
- ECS Exec (interactive debugging)

## Docker & Container Images

- Dockerfile best practices (multi-stage, minimal base, layer optimization, security hardening)
- Base image strategy (distroless, alpine, slim, AL2023)
- Multi-architecture builds (buildx, manifest lists, amd64/arm64)
- ECR (repositories, lifecycle policies, scanning, replication, cross-account, signing)
- Image supply chain (Notation, Sigstore, admission control)
- BuildKit features (cache mounts, secret mounts, SSH mounts)

## Container Networking

- VPC CNI plugin (configuration, prefix delegation, custom networking)
- Service mesh (VPC Lattice, Istio, App Mesh)
- Load balancing (ALB, NLB, Gateway API, AWS Load Balancer Controller)
- DNS (CoreDNS, External DNS, node-local DNS cache)
- Network Policies (Calico, VPC CNI)
- Security groups for pods

## Container Security

- Pod Security Standards / Admission (restricted, baseline, privileged)
- Admission control (OPA/Gatekeeper, Kyverno)
- ECR enhanced scanning (Inspector integration)
- GuardDuty Runtime Monitoring (EKS, ECS, Fargate)
- Secrets management (Secrets Store CSI Driver, ECS secrets references)
- Image signing and verification
- Bottlerocket (immutable OS, auto-update)
- CIS Kubernetes Benchmark

## Container Observability

- CloudWatch Container Insights (enhanced observability)
- ADOT (AWS Distro for OpenTelemetry)
- Prometheus / Grafana (Amazon Managed Prometheus, Amazon Managed Grafana)
- Fluent Bit (log routing)
- X-Ray (distributed tracing)
- Karpenter metrics and events
