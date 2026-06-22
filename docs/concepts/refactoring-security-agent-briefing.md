# Refactoring & Security Agent Workflow — Codebase Debate Briefing

> **Purpose of this document.** This is a context-loading briefing for a follow-on debate to be run _against an actual codebase_. It captures the originating concern, the goal, the research findings, the proposed architecture, and — most importantly — a set of **contestable positions, flags, and open questions** designed to be argued for and against. Treat the "Recommendations" as a thesis to be stress-tested, not as settled fact.

> **Date of research:** April 2026. **Stack assumed:** TypeScript/Node, React, AWS-native (eu-central-1, GDPR), ECS Fargate / Lambda / DynamoDB / S3 / CloudFront / Cognito / Bedrock, SST/Pulumi IaC, Claude Code with multi-terminal/worktree workflow. **Imminent addition:** Stripe (subscriptions, donations).

---

## 1. The Concern (as stated)

The author is a solo founder running a portfolio of AI-native products built rapidly over ~2 months of prototyping. The codebases work but were built fast, by a self-described non-expert developer. The concern is twofold:

1. **Code quality / entropy.** Bugs are hard to detect and manage. Code is organized as isolated functions per module — or worse, inline — rather than as coherent, reusable components. Levels of abstraction are inconsistent. Function definitions are uneven. There is no enforced standard.
2. **Security.** Scanning "backwards" through existing code for security breaks: `.env` / key exposure, authentication inconsistencies, bad cookie management, CORS attack surface — extended to AWS architecture (firewalls, region deployments, VPCs) and the upcoming Stripe payment flows.

The chosen approach is an **agentic workflow running on a Claude Code subscription (no API calls)**, orchestrated via bash scripts launching agents in isolated terminals.

---

## 2. The Goal

Build a **Refactoring Agent Workflow** that:

- Analyzes full modules (Authorization, Multitenancy, Agentic Orchestration, etc.) and component classes (UI components, AI providers).
- Assesses code quality at multiple levels: function definitions, levels of abstraction, component-vs-isolated-function organization, inline-code reduction.
- Simultaneously performs a **security audit** while scanning backwards.
- Extends security concern to the AWS deployment architecture and the forthcoming Stripe integration.
- Establishes a deterministic baseline first (ESLint, Husky, Prettier, knip, strict types) so the probabilistic agent only spends judgment where it adds value.

---

## 3. Research Findings (April 2026)

### 3.1 Anthropic Mythos & Project Glasswing — relevant prior art

- Mythos is Anthropic's new frontier model, **not publicly available**, launched April 7 2026 via **Project Glasswing** (partners incl. AWS, Apple, Microsoft, CrowdStrike, Google).
- In weeks of use it found **thousands of high-severity zero-days**, including bugs in every major OS and browser, some decades old (oldest: a 27-year-old OpenBSD bug).
- **The replicable pattern (this is the key takeaway):** Anthropic's scaffold is deliberately _simple_ — a container with source code, Claude Code invoked with the model, and a prompt to find vulnerabilities. The agent reads code → hypothesizes → runs the project to confirm → outputs a bug report with PoC and repro steps. A final agent triages: "Is this real and interesting?"
- **Implication for this project:** No exotic framework is needed. Claude Code in a terminal, scoped to one module, with git as a safety net and tests as a regression guard, is current state-of-the-art. The author cannot use Mythos, but the _architecture_ is the thing to copy.

### 3.2 Claude Code orchestration primitives

- **Agent Teams** (research preview, v2.1.32+, requires Opus 4.6): multiple Claude instances work in parallel, coordinating through a git-based system — claiming tasks, merging continuously, resolving conflicts.
- **`/batch`**: built-in, orchestrates parallel refactoring across a codebase using **git worktrees** for isolation. Directly relevant to the multi-terminal/worktree workflow already in use.
- **`/simplify`**: runs a 3-agent code review and applies fixes.
- **Checkpointing**: Esc-Esc / `/rewind` restores code/conversation state; persists across sessions; complements (does not replace) git.

### 3.3 Public refactoring skills (verified, with caveats)

- **`l-mb/python-refactoring-skills`** — closest match to the proposed architecture. 8 modular skills mapping near 1:1 to the proposed phases: `py-refactor` (orchestrator), `py-security` (bandit/ruff), `py-complexity` (radon/lizard/wily), `py-code-health` (vulture dead-code), `py-quality-setup`, `py-git-hooks`. Stated philosophy matches the author's instinct exactly: _use deterministic tooling as guardrails — "if the hooks catch it, you don't have to."_ **Caveat:** Python-only, 14 stars, single maintainer → reference design, not a dependency.
- **`cdd.dev/skills`** (via `rohitg00/awesome-claude-code-toolkit`) — `swe` set (PR risk review, repo introspection, security audits, refactor opportunities, test-gap hunts) and `hone` set (cadence-based entropy fighters: method brevity, naming clarity, duplication, magic numbers, broken-windows).
- **`wondelai/skills`** — explicit `refactoring-patterns` skill grounded in Ousterhout's _A Philosophy of Software Design_ (deep modules, information hiding, strategic programming). Aligns with the component-over-isolated-functions goal.
- **`VoltAgent/awesome-agent-skills`** — most credible curation; real engineering-team skills (Anthropic, Stripe, Trail of Bits, Cloudflare, Sentry). Official **Stripe** skill set and **Trail of Bits** security skills are directly relevant.
- **`anthropics/skills`** — canonical SKILL.md authoring reference.
- **Supply-chain warning (verified in ecosystem reporting):** malicious skills have circulated; one source cited 655 malicious skills in the supply chain and 24 CVEs in the Claude Code ecosystem. **Do not bulk-install. Read every SKILL.md before adoption.**

### 3.4 AWS security tooling

- **AWS Security Agent** (preview, Dec 2025): frontier agent doing context-aware app security reviews + on-demand pen testing; understands app design + code + requirements (unlike one-dimensional SAST/DAST).
- **Amazon Inspector**: now does SAST + SCA + IaC scanning, native GitHub/GitLab integration, scans CloudFormation/Terraform/CDK for misconfig (IAM wildcards, disabled encryption), suggests fixes in PRs.
- **AWS Automated Security Helper (ASH v3)**: open-source SAST/SCA/IaC orchestrator; runs local / container / pre-commit; wraps Bandit, Checkov, Semgrep. Good fit for Husky pre-commit hooks.

### 3.5 Stripe security baseline

- Stripe is **PCI Level 1 Service Provider**, but PCI compliance is a **shared responsibility**.
- Using **Stripe Elements / Checkout** keeps card data off your servers → you fall under **SAQ A** (simplest tier). This is the single highest-leverage decision.
- Non-negotiables: TLS 1.2+; verify webhook signatures (`stripe.webhooks.constructEvent()`); secret keys only in Secrets Manager / env (never in code); idempotency keys on payment creation; no logging of card data; CSP directives for Stripe.js.

---

## 4. Proposed Architecture (the thesis to debate)

A 5-phase multi-agent pipeline. **Deterministic-first:** linters/type-checkers/dead-code detection run before and alongside the LLM agents.

| Phase | Agent                       | Responsibility                                                                                                      |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1     | **Cartographer** (Analysis) | File inventory, complexity metrics, dependency graph, type coverage, code smells, abstraction opportunities         |
| 2     | **Janitor** (Lint/Format)   | ESLint + `@typescript-eslint`, Prettier, Husky + lint-staged, knip, `tsconfig strict`                               |
| 3     | **Architect** (Refactor)    | Characterization tests _first_, then extract shared utilities, type inline code, apply SRP, Strangler-Fig migration |
| 4     | **Sentinel** (Security)     | Secrets/`.env`, auth/cookies/CORS, AWS IAM/SG/VPC/S3/Bedrock/Cognito, Stripe, GDPR/EU AI Act                        |
| 5     | **Judge** (Review)          | Cross-reference all reports, produce severity-ranked action plan                                                    |

**Orchestration:** bash scripts launching per-module agents in tmux windows / git worktrees; `--print --output-file` for report-producing phases; Agent Teams for parallel refactor work.

### Code-quality detection layers (macro → micro)

- **L1 Architecture** — module boundaries, circular deps, separation of concerns.
- **L2 Component** — shared vs. duplicated implementations across the portfolio.
- **L3 Function** — cyclomatic complexity > 8 → extract; > 30 lines → extract; > 3 params → options object; no `any`.
- **L4 Line** — no inline styles, no magic strings (enums/constants), no `console.log`, no commented-out code.
- **L5 Security** — see Sentinel scope.

### Sentinel AWS checklist (concrete)

- Security Groups: no `0.0.0.0/0` ingress on non-80/443.
- VPC: private subnets for Fargate; NAT for outbound.
- DynamoDB: encryption at rest; IAM scoped per-table.
- S3/CloudFront: no public buckets; OAC configured.
- Bedrock: IAM scoped to specific model IDs in eu-central-1.
- Cognito: MFA; token expiry; no wildcard callback URLs.
- API Gateway: WAF attached; throttling; auth on all routes.
- Lambda: no wildcard IAM roles; secrets via Secrets Manager.

---

## 5. Flags & Warnings (argue these hard)

1. **LLM-generated refactors introduce logic errors.** Cited research: Claude Code can generate ~1.75× more logic errors than human-written code. **Every refactor must be verified by tests, not by eye.** Characterization tests (assert _current_ behavior) must exist before any refactor touches a module.
2. **Context-window degradation.** Precision drops ~70% context, hallucinations rise ~85%, erratic ~90%+. Scope agents to one module; `/compact` at 50%, `/clear` when switching. A "refactor the whole monorepo" prompt is an anti-pattern.
3. **Skill supply-chain risk.** Do not install community skills blind. Read SKILL.md. Prefer translating patterns into your own TS-native skills over importing unaudited ones.
4. **Solo-founder bus-factor / over-automation.** Agentic refactoring that the author can't read and understand is debt, not progress. The tooling must make the code _more_ legible to a non-expert, not less.
5. **Refactoring without a rollback discipline is dangerous.** Clean git branch + commit before each batch; small batches; checkpoints as instant undo; git for reviewable history.
6. **Security scanning ≠ security.** SAST/agents find a subset. They do not replace threat modeling, dependency monitoring (SCA), or runtime concerns. False-positive fatigue is real — introduce rulesets incrementally.
7. **Stripe is a compliance surface, not just an integration.** Going live before the Sentinel pass + SAQ-A confirmation is a sequencing error.
8. **EU AI Act / GDPR overlay.** Given the author's regulatory work (Article 5 prohibited practices, AEPD/AESIA), the codebase audit should explicitly check data retention, consent flows, right-to-erasure, and any biometric/emotion-recognition code paths against prohibited-practice triggers.

---

## 6. Best Practices (proposed defaults)

- **Deterministic guardrails first.** ESLint/Prettier/Husky/knip/strict-types before the smart agent. Cheap non-probabilistic checks catch the obvious; LLM judgment is reserved for genuine design decisions.
- **One module at a time.** Auth, then Multitenancy, then Orchestration — each with its own report, its own branch, its own test harness.
- **Characterization tests gate every refactor.**
- **Conventional Commits**, one logical change per commit.
- **CLAUDE.md per repo** encoding architecture, naming conventions, branch strategy, testing requirements — so every agent shares ground truth.
- **Report-to-disk, not hidden state.** Agents communicate via structured markdown/JSON reports (Cartographer → Architect → Sentinel → Judge), enabling resume-after-compaction.
- **Severity-ranked output**: Critical (now) / High (sprint) / Medium / Low (backlog).
- **Continuous layer**: Amazon Inspector on repos for ongoing SAST/SCA after the one-time backwards scan.

---

## 7. Extensions & Open Threads

- **TS-native skill set.** Translate the `l-mb` 8-skill design to TypeScript: knip → dead code; eslint complexity rules → radon/lizard; semgrep → bandit; mutation testing via Stryker → mutmut.
- **Portfolio-level deduplication.** With 9 products, the highest-value refactor may be _cross-repo_: extracting shared components (button libraries, API clients, auth wrappers) into shared packages — consistent with the existing Turborepo monorepo strategy. The agent should detect "the same thing implemented N ways."
- **Cadence vs. batch.** The `hone` model (per-PR/daily/weekly entropy checks) complements one-time batch refactoring. Decide which runs when.
- **Debate-engine integration.** This briefing is intended to seed a structured debate (e.g., Six Thinking Hats / Blue Hat Orchestrator) _against the real codebase_ — White Hat (what the metrics actually say), Black Hat (where the agent will break things), Green Hat (cross-repo abstraction opportunities), Red Hat (the non-expert's gut on legibility).

---

## 8. Positions to Debate Against the Codebase

These are framed as contestable claims. For each, the debate should gather evidence _from the actual repo_ and argue both sides.

1. **"Deterministic-first is correct here."** — vs. the counter that strict linting on a 2-month prototype produces thousands of errors that bury real signal and stall momentum.
2. **"Characterization tests before refactor are mandatory."** — vs. the counter that for throwaway/early-stage modules, test-first refactoring is premature optimization that slows a solo founder.
3. **"Component extraction over isolated functions improves this codebase."** — vs. the counter that premature abstraction (DRY before the third repetition) is itself a common AI-introduced smell. _Where exactly is the line in THIS code?_
4. **"The security backwards-scan should block all feature work until clean."** — vs. risk-based triage that ships with known-low findings.
5. **"Stripe must wait for the Sentinel pass."** — vs. shipping Elements/Checkout (SAQ-A) immediately since it keeps card data off-server regardless.
6. **"Cross-repo deduplication is the highest-leverage move."** — vs. the counter that coupling 9 products through shared packages creates a single point of failure and slows independent iteration.
7. **"Agent-driven refactoring is net-positive for a non-expert solo founder."** — vs. the counter that it widens the gap between what's shipped and what the author understands.

---

## 9. Inputs the Debate Will Need From the Repo

To argue the above with evidence rather than priors, extract:

- Per-module: LOC, file count, function-length distribution, cyclomatic complexity histogram, `any`-type ratio.
- Dependency graph + circular dependency list.
- knip output: unused exports, unused deps, unreferenced files.
- Duplication report (cross-file and cross-repo).
- Secrets scan: any keys/tokens in source or git history.
- Auth/cookie/CORS config inventory.
- IaC scan (Inspector/Checkov) of SST/Pulumi definitions.
- Current test coverage and where it's absent.

---

_End of briefing. The "Recommendations" herein are a thesis. The next session's job is to falsify them against the real code._
