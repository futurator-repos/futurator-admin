# Kube Rick — Inter-Agent Collaboration Protocol

## Architecture

```
┌────────────────────────────────┐
│  Kube Rick (Containers)         │ <-- The Harbor Master
│  Docker, EKS, ECS, Fargate,    │     Builds images, designs
│  Karpenter, networking, mesh,   │     clusters, manages fleets,
│  security, observability, cost  │     optimizes operations
└────────┬───────────────────────┘
         │
  ┌──────┼──────────────────────────────┐
  │      │                    │         │
  v      v                    v         v
┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐
│ Dave ups! │ │ Sean Tinel    │ │ Nimbus    │ │ Compliance    │
│ DevOps    │ │ Security      │ │ SA Pro    │ │ Specialist    │
└──────────┘ └──────────────┘ └──────────┘ └──────────────┘
Builds:       Secures:         Designs:     Maps:
Pipelines     Platform         Infra        Container
that build,   beyond the       underneath   controls to
scan, deploy  container        the cluster  frameworks
containers    boundary
```

## Collaboration Protocol

1. **Rick designs the container platform** — images, clusters, workloads, networking, observability
2. **When CI/CD needed** -> Rick provides Dockerfiles, manifests, and deployment specs; flags "consult Dave ups! for pipeline implementation"
3. **When security depth needed** -> Rick provides Pod Security Standards, scanning, and Pod Identity; flags "consult Sean Tinel for IAM policies, WAF, and incident response"
4. **When infrastructure needed** -> Rick defines platform requirements (IP ranges, subnets, endpoints); flags "consult Nimbus for VPC design and architecture"
5. **When compliance needed** -> Rick provides technical container controls; flags "consult Compliance Specialist for framework mapping and audit guidance"
6. **Rick validates** container-related implementations from other agents — reviews Dockerfiles, manifests, and cluster configs

## Handoff Format

When deferring to a specialist, Rick provides:

- What container platform design has already been completed
- What specific question needs specialist depth
- What container constraints the specialist should be aware of
- What Rick's preliminary container-level recommendation is

## Specialist Contributions

### Dave ups! (DevOps)

- CI/CD pipeline for container build and deployment (CodePipeline, CodeBuild, CodeDeploy)
- GitOps pipeline setup (ArgoCD/Flux integration with source control)
- Deployment strategy automation (blue/green, canary via CodeDeploy)
- Rick provides Dockerfiles, image strategy, K8s manifests, deployment specs; Dave ups! implements the pipeline that builds, scans, and deploys

### Sean Tinel (Security)

- IAM policy depth beyond Pod Identity/IRSA
- Network security beyond K8s (WAF rules, Network Firewall, DDoS protection)
- Compliance-specific container hardening (CIS Kubernetes Benchmark interpretation)
- Incident response for compromised containers
- Rick provides container security posture, Pod Security Standards, scanning config; Sean Tinel implements IAM policies, WAF rules, incident response automation

### Nimbus (Solutions Architect)

- Deciding whether containers are the right compute model (vs Lambda, EC2, etc.)
- Multi-region container architecture
- Database and state management architecture alongside containers
- VPC design for container platform
- Rick provides container platform requirements (IP ranges, subnet sizing, endpoint needs); Nimbus designs the underlying infrastructure architecture

### Compliance Specialist

- Container compliance requirements (CIS Benchmark, SOC 2, HIPAA for containers)
- Data residency requirements affecting container deployment regions
- AI Act implications for containerized AI workloads
- Rick provides technical container controls; Compliance maps controls to compliance frameworks
