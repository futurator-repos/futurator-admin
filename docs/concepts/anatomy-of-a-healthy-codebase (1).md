# Anatomy of a Healthy Codebase

_A reference on what software engineers mean by "code quality" — the principles, the policies, and the tooling that enforces them._

---

## How to read this document

Code quality is not one thing. It is a stack of concerns that engineers tend to lump under a single word, which is why conversations about it often talk past each other. It helps to see it as **five layers**, each answering a different question:

| Layer                  | The question it answers                                       |
| ---------------------- | ------------------------------------------------------------- |
| **1. The Code Itself** | Is it easy to read, change, and reason about?                 |
| **2. Safety Nets**     | What catches mistakes before users do?                        |
| **3. Enforcement**     | What makes the standards automatic and non-negotiable?        |
| **4. Knowledge**       | Can a human (or an agent) reconstruct _intent_ and _history_? |
| **5. Operational**     | How does the code behave, and how do we see it, in the wild?  |

The single most important idea running through all five layers: **a healthy codebase is one where the quality standard lives in the pipeline, not in people's heads.** Every practice below can exist either as a habit you hope people follow, or as a gate that mechanically enforces it. Mature codebases push relentlessly toward the latter — and in an agent-orchestrated system, that machine-checkable layer _is_ your management layer.

---

## Layer 1 — The Code Itself

This is the layer most people picture when they hear "code quality," but it is also the most subjective. The discipline here is converting taste into rules.

### Project structure & architecture

A predictable folder tree is the cheapest form of documentation. The goal is that any contributor — or agent — can guess where a thing lives without searching. Two dominant organizing philosophies:

- **Layer-based** (group by technical role: `/controllers`, `/services`, `/models`). Simple, familiar, but related code for one feature ends up scattered across the tree.
- **Feature-based / vertical slices** (group by domain: `/billing`, `/auth`, `/playback`, each containing its own UI, logic, and tests). Scales better because a feature is self-contained, and it maps cleanly onto how work is actually assigned.

The deeper architectural principle is **module boundaries**: a module should expose a small, deliberate public interface and hide its internals. When modules reach into each other's guts, you get a "big ball of mud" where every change ripples unpredictably. This is the architect's primary responsibility, and it is worth being explicit about which modules are allowed to depend on which (a dependency graph you can actually draw and enforce).

### Naming & readability

Code is read far more often than it is written, so readability is not a nicety — it is the property that determines how expensive every future change will be. Concretely:

- **Intention-revealing names.** `getActiveUsersSince(date)` beats `getData(d)`. The name should make the comment unnecessary.
- **Consistency over personal preference.** Whether the team writes `userId` or `user_id` matters far less than that _everyone_ writes it the same way. Consistency is what lets you read unfamiliar code as if you wrote it.
- **Small, single-purpose functions.** A function that does one thing can be named accurately. A function that does five things gets a vague name and becomes a place bugs hide.

### Complexity

Engineers measure readability indirectly through complexity metrics:

- **Cyclomatic complexity** — the number of independent paths through a function (roughly, how many branches and loops). High numbers mean the function is hard to test and hard to hold in your head.
- **Cognitive complexity** — a refinement that weights _nested_ logic more heavily, because deeply nested code is disproportionately hard for humans to follow.
- **Nesting depth and function length** — blunt but effective proxies. A function with five levels of indentation is almost always doing too much.

These can be enforced as hard limits by linters, which turns "this feels too complicated" into "this fails CI." That is the move that matters: making taste mechanical.

### Abstraction, DRY, and the design system

Your original instinct here was exactly right. The failure mode is **uncontrolled duplication and divergence**: one developer inline-styles a button, another writes their own color palette, a third hand-rolls an error toast. Each is locally reasonable; collectively they produce an inconsistent product and a maintenance nightmare, because a single change (a new brand color, a new error format) now has to be made in dozens of places.

The antidote is **shared, single-source-of-truth abstractions**:

- For UI: a **design system** — a library of tokens (colors, spacing, typography) and components (buttons, inputs, modals) that everyone composes from. Tools like Storybook let you develop and document these in isolation.
- For everything else, the same principle: a shared `logger`, a shared error class hierarchy, a shared HTTP client with retry policy baked in, a shared deployment script. The rule is: **if two pieces of code need to behave the same way, that behavior should exist in exactly one place.**

A caution that experienced engineers add: **don't abstract too early.** Premature abstraction (the "DRY at all costs" trap) couples things that only _look_ similar and later need to diverge. The mature heuristic is the "rule of three" — extract a shared abstraction once you have three real instances, not two.

### Coupling, cohesion, and SOLID

Underneath good abstraction sit two foundational properties:

- **High cohesion** — the things inside a module belong together and serve one purpose.
- **Low coupling** — modules depend on each other's _stable interfaces_, not their internals, so a change in one doesn't force changes in others.

The **SOLID** principles are the most-cited articulation of how to achieve this in object-oriented code (Single responsibility, Open/closed, Liskov substitution, Interface segregation, Dependency inversion). You don't need to memorize them, but the through-line is: _depend on abstractions, keep responsibilities separate, and design so that change stays local._ A classic smell that these have broken down is a **circular dependency** (module A needs B, which needs A) — detectable automatically, and almost always a sign your boundaries are wrong.

### Clutter & dead code

Change is constant, so code rots: functions get superseded, exports go unused, dependencies get installed and forgotten. Dead code is not harmless — it inflates cognitive load (people read it trying to understand the system), it can hide bugs, and it expands the attack surface. The policy is **continuous pruning**, ideally automated: a tool that reports unused files, exports, and dependencies, run in CI so clutter is caught as it appears rather than archaeologically excavated later.

---

## Layer 2 — Safety Nets

These are the mechanisms that catch defects automatically. They are what let you change code _fearlessly_, because you trust that breakage will be caught.

### Type safety

Static typing (TypeScript, in your stack) is the cheapest, fastest safety net. It catches a huge class of errors — typos, wrong shapes, null/undefined access — at author-time, before the code ever runs. The key policy decisions:

- **`strict` mode is table stakes.** Half-enabled TypeScript gives a false sense of safety. The strict family of flags (especially `noImplicitAny` and `strictNullChecks`) is where most of the value lives.
- **Types as design.** Well-typed function signatures and data models force you to think about edge cases up front (what if this is empty? what if the fetch fails?). The types become a lightweight, always-accurate specification.
- **Type-aware linting** goes further than the compiler, catching patterns like floating promises (an `async` call you forgot to `await`) that are technically valid but almost always bugs.

### Testing

This is the central pillar of the safety-net layer, and the one most worth investing in. A few principles engineers treat as canon:

- **The test pyramid.** Many fast **unit** tests (a single function/module in isolation), fewer **integration** tests (several units working together, real database, etc.), and a small number of slow **end-to-end** tests (the whole system through the UI). Inverting this — relying mostly on slow e2e tests — produces a suite that is slow, flaky, and distrusted.
- **Coverage is a guide, not a target.** Code coverage tells you what is *un*tested; it does not tell you what is _well_-tested. The moment "90% coverage" becomes a goal, people write hollow tests that execute code without asserting anything meaningful (Goodhart's law: a measure that becomes a target stops being a good measure).
- **Determinism is non-negotiable.** A flaky test — one that passes sometimes and fails sometimes — is _worse_ than no test, because it trains the whole team to ignore red. Achieving determinism means isolating tests from shared state, controlling time (mocked clocks), and mocking external boundaries (network, filesystem).
- **Tests as executable specification.** Good tests document _what the code is supposed to do_ in a form that can't go stale, because if the behavior changes, the test fails.
- **The feedback-loop angle.** For your situation specifically, tests are the signal that lets an agent self-correct. "Looks good" is not machine-readable; a failing test is. A solid suite is the difference between an agent confidently shipping a regression and an agent being told, immediately and unambiguously, that it broke something.

### Error handling

A deliberate, codebase-wide **error-handling policy** is what separates a system that fails gracefully from one that fails mysteriously. The elements of a good policy:

- **A typed error hierarchy.** Distinguish _operational_ errors (expected: a network timeout, a validation failure, a 404) from _programmer_ errors (bugs: a null dereference, a broken invariant). They demand opposite treatment — operational errors should be handled and recovered from; programmer errors should crash loudly so they get fixed.
- **Fail fast, fail loud — at the right boundary.** Validate inputs at the edges of the system and reject bad data early, rather than letting it propagate and corrupt state deep inside.
- **Never swallow errors silently.** An empty `catch` block is one of the most dangerous things in a codebase. Every caught error should be either handled meaningfully or re-thrown with added context.
- **Error context and propagation.** When an error crosses a boundary, wrap it with context ("failed to load user 123 while rendering invoice") so the eventual log entry tells a story rather than showing a bare stack trace.
- **User-facing vs developer-facing.** Decide deliberately what the _user_ sees (a friendly, non-leaky message) versus what gets _logged_ for developers (the full detail). Never leak internal detail or secrets in a user-facing error.

### Input validation

A specific, security-critical case of error handling: never trust data crossing a trust boundary (user input, API responses, file contents). Validate and sanitize it at the edge, ideally with a schema validation library so the rules are declarative and reusable, and the validated data is correctly typed downstream.

---

## Layer 3 — Enforcement

This layer is what turns every principle above from an aspiration into a guarantee. The governing rule: **if a standard isn't enforced automatically, it's just a suggestion** — and humans (and agents) drift.

### Linting & formatting

Two distinct jobs, often conflated:

- **Formatting** is purely cosmetic — indentation, quotes, line length. It should be 100% automated and never discussed in code review. A formatter rewrites the code to a canonical style on save or commit, which ends all style debates permanently.
- **Linting** is about _correctness and quality_ — catching likely bugs, banned patterns, complexity violations, accessibility issues. A linter is a programmable rulebook for "things we don't allow in this codebase."

### The enforcement chain

Standards get applied at escalating gates, each catching what the previous missed:

1. **Editor / on-save** — formatting and lint feedback as you type. Fastest loop, but skippable.
2. **Pre-commit hook** — runs fast checks (format, lint, typecheck) on _staged files only_ before a commit is allowed. This is the husky/lint-staged layer. Fast and local.
3. **Pre-push hook** — heavier checks (e.g. the test suite) before code leaves your machine.
4. **CI pipeline** — the full, authoritative gate, run on a clean machine: lint, typecheck, complete test suite, build, security scans, dead-code check. This is the source of truth because it can't be skipped or misconfigured locally.
5. **Branch protection** — the rule that a pull request _cannot be merged_ unless CI is green and the required reviews are approved. This is the actual "quality gate." Everything upstream is convenience; this is the wall.

The combination is what people mean by **CI/CD quality gates**. For an agent-driven pipeline this is the load-bearing concept: the gate is how you supervise output you can't review line-by-line. The more of your quality standard you can express as a check an agent gets red/green feedback on, the more the system holds together as complexity grows.

### Commit and change hygiene

A small but high-leverage practice: enforce a **commit message convention** (e.g. Conventional Commits: `feat:`, `fix:`, `chore:`). This makes history readable, enables automated changelog generation and semantic versioning, and gives agents a structured signal about the nature of each change.

---

## Layer 4 — Knowledge

Git tells you _what_ changed and _when_. It is terrible at _why_. The most expensive knowledge loss in any codebase is the reasoning behind decisions — and this layer is how you prevent it.

### Documentation

A pragmatic hierarchy, from most to least essential:

- **README** — the front door. How to install, run, test, and deploy. If a new contributor (or a fresh agent session) can't get the project running from the README, the README has failed.
- **Runbooks** — operational docs: "what to do when X breaks," "how to roll back," "how to rotate this credential." These pay for themselves the first time something breaks at an inconvenient hour.
- **API / interface docs** — generated from the code where possible, so they can't drift out of sync.

### Architecture Decision Records (ADRs)

This is the highest-value documentation practice and the one most teams skip. An ADR is a short, dated, append-only markdown file committed alongside the code that captures **a decision, its context, the alternatives considered, and the consequences.** "Why did we choose DynamoDB over RDS here?" "Why is this retry logic so strange?" (Because of a specific throttling behavior, probably.) Without ADRs, that reasoning evaporates and future contributors either cargo-cult the decision or undo it without understanding the cost.

For your cross-session and agent work specifically, ADRs are how an agent in a fresh context reconstructs intent without you re-explaining it. They are durable, version-controlled, machine-readable memory — a complement to anything you build with vector stores.

### Comments

The rule is: **comments explain _why_, not _what_.** `i++ // increment i` is noise that will rot. `// Bedrock rate-limits us at 5 RPS in eu-central-1, so we batch here` is gold. Good code is self-documenting at the _what_ level (through naming and structure); comments are reserved for the context that the code itself cannot express — the non-obvious reason, the workaround, the link to the bug ticket.

### Code review culture

The human side of quality. The practices that distinguish good review from rubber-stamping:

- **Small PRs.** A 50-line PR gets a real review; a 2,000-line PR gets "LGTM." Reviewability scales inversely with size.
- **Review design, not just bugs.** The most valuable review comments are about whether the _approach_ is right, not just whether the syntax is.
- **Blameless tone.** Review critiques the code, not the author. A culture where review feels like attack produces defensive, low-quality engineering.

### Version control & history

You already run this layer well — branches, worktrees, PRs, the workflow that enables parallel work and rollback. The quality dimensions worth naming: a **branching strategy** everyone follows (trunk-based or GitHub Flow for most teams), **atomic commits** (each commit is one coherent change, which makes `git bisect` and rollback precise), and a clean, linear-enough history that the log is actually a useful narrative rather than noise.

---

## Layer 5 — Operational

How the code behaves once it's running, and how you can see what it's doing. Your interest in logging and auditing lives here — but it's part of a bigger picture.

### Observability

The modern frame unifies your separate interests in logging and auditing. Observability has **three pillars**:

- **Logs** — discrete, timestamped events ("user 123 logged in," "payment failed: card declined"). Your interest in useful terminal/console output is this pillar.
- **Metrics** — aggregated numbers over time (error rate, request latency, throughput, queue depth). This is the pillar your original list was missing entirely, and it's the one that tells you _the system is degrading_ before it actually breaks.
- **Traces** — the path of a single request as it flows across services, with timing at each hop. This is what makes "why is this one request slow?" answerable in a distributed system.

The practical policies that make observability useful rather than noise:

- **Structured logging.** Emit logs as JSON (key-value fields), not free-text strings. Structured logs are queryable, filterable, and aggregatable; string logs are not.
- **Log levels with a clear policy.** `debug` / `info` / `warn` / `error`, with explicit rules about what belongs at each level and — critically — what is allowed to be logged in production (debug logging in prod is a performance and privacy hazard).
- **Correlation IDs.** Attach a unique ID to each request and propagate it through every log line and service it touches, so you can reconstruct the full story of one request out of millions.
- **Don't log secrets or personal data.** Especially under GDPR, logs are a data store like any other and must respect the same rules. Redaction policy is part of your logging policy.

### Auditing

A specialized, compliance-driven cousin of logging: an **immutable, tamper-evident record of security- and business-significant events** — who accessed what, who changed what, who consented to what, when. For regulated data (GDPR Article 9 categories, financial records) audit logs are often a legal requirement with their own retention and integrity rules, distinct from operational logs.

### Security

Security is not separate from code quality — it _is_ code quality, and given your compliance constraints it is foundational. The hygiene layer, "shifted left" into the pipeline:

- **Secret scanning** — catch credentials (API keys, tokens) _before_ they reach git history, both at commit time and in CI. A leaked key in git history is permanent until rotated.
- **SAST (Static Application Security Testing)** — analyze source code for vulnerable patterns (injection, unsafe deserialization, etc.).
- **SCA (Software Composition Analysis)** — scan your dependencies for known vulnerabilities (CVEs).
- **Input validation & least privilege** — validate everything at trust boundaries (above), and give every component (IAM roles, service accounts) the minimum permissions it needs and no more.

### Dependency & supply-chain management

Most of your code's _executed_ lines are dependencies you didn't write, which makes this an outsized and often-invisible quality concern:

- **Lockfiles** pin exact versions (including transitive ones) so builds are reproducible — the same input produces the same output every time.
- **Automated, controlled updates.** A bot that opens small, frequent update PRs keeps you current in safe increments, rather than facing a terrifying big-bang upgrade once a year.
- **Vulnerability scanning** of dependencies on every build.
- **License compliance.** A copyleft (e.g. GPL) license sneaking in via a transitive dependency can be a genuine legal problem for a commercial product — worth scanning for.
- **An SBOM (Software Bill of Materials)** — a machine-readable inventory of everything in your build, increasingly required for compliance and indispensable when a new CVE drops and you need to answer "are we affected?" in minutes.

### Configuration & secrets management

Following the **12-factor** principle: **config lives in the environment, never in code.** Secrets live in a dedicated manager (a vault / secrets service), never in the repo. And **feature flags** decouple _deploy_ from _release_ — you can ship code dark and turn it on later, which de-risks deployment enormously and enables instant rollback of a feature without a redeploy.

### Infrastructure as Code (IaC) quality

Your infrastructure definitions are _code_, and they deserve the same quality bar as application code — arguably more, since a bad change to infrastructure is harder to roll back than a bad change to a function. That means linting, review, testing, and security scanning (IaC-specific scanners catch misconfigured permissions, public buckets, unencrypted storage) applied to your IaC just as rigorously as to your app.

### Performance & accessibility

Depending on the product, these are first-class quality dimensions rather than afterthoughts:

- **Performance budgets** — explicit limits (bundle size, load time, query latency) enforced in CI, so regressions are caught rather than discovered by users.
- **Accessibility (a11y)** — for any UI, conformance to accessibility standards is both an ethical baseline and, in the EU, increasingly a legal one. It can be partially automated in CI and partially checked in component tests.

---

## The unifying principle

Every item in this document reduces to one idea: **convert quality from something people remember to do into something the system guarantees.** Each principle has a manual form (a habit, a convention, a code-review comment) and an enforced form (a gate that blocks the merge). The trajectory of a maturing codebase is the steady migration of items from the first column to the second.

For an agent-orchestrated pipeline this is not optional polish — it is the architecture. You cannot review every line an agent writes, so the machine-checkable gates (types, tests, lint, complexity ceilings, security scans, dead-code detection, CI) _become_ your supervisory layer. The design question for your pipeline is therefore: **for each quality concern above, what is the check, where does it run, and is it blocking or advisory?** A codebase where the answer is "automated and blocking" for most of these is, by the working definition of professional software engineering, a healthy one.

---

## Appendix — Tooling landscape (current as of 2026)

Tools evolve fast; this captures the current state of each category, flagging what is the established default versus what is newer and rising. Status notes reflect the 2026 landscape.

### Linting & formatting (JS/TS)

| Tool                        | Purpose                      | Status / notes                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESLint v9**               | Linting                      | The ecosystem default (~130M+ weekly downloads). v9 introduced "flat config" (`eslint.config.js`); the old `.eslintrc` is deprecated. Unmatched plugin ecosystem (framework, a11y, security, import rules). Still the safest choice for mature product codebases. |
| **Biome v2**                | Lint **+** format (one tool) | Rust-based, ~10–20× faster than ESLint+Prettier. v2 added **type-aware linting**, closing the biggest gap. Best all-in-one for greenfield projects; `biome migrate prettier` eases adoption. Can't do custom rules.                                               |
| **Oxlint** (Oxc / VoidZero) | Linting                      | Rust-based, **50–100× faster** than ESLint. Common 2026 pattern: Oxlint as an instant pre-pass for trivial errors, then ESLint only on files that pass, for large CI time savings. Auto-fix coverage still selective; ~300 rules vs ESLint's 700+.                |
| **Prettier**                | Formatting                   | The long-standing formatting standard; opinionated, zero-config. Still ubiquitous, though Biome and Oxfmt are eroding its share.                                                                                                                                  |
| **Oxfmt** (Oxc)             | Formatting                   | Newer Rust formatter from the Oxc project; Prettier-compatible output at much higher speed.                                                                                                                                                                       |
| **Vite+** (VoidZero)        | Unified toolchain            | **New (shipped March 2026).** One CLI wrapping Vite, Rolldown (bundler), Vitest, Oxlint, Oxfmt, and Tsdown. Represents the 2026 consolidation trend — worth watching as a single-tool replacement for a hand-wired chain.                                         |

### Types & dead code

| Tool           | Purpose                                  | Status / notes                                                                                                                                    |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript** | Static typing                            | Universal. `strict` mode is now considered table stakes.                                                                                          |
| **Knip**       | Dead code / unused exports / unused deps | The current standard, superseding the older `ts-prune`. Finds unused files, exports, and dependencies in one tool. Run in CI to keep clutter out. |
| **depcheck**   | Unused dependencies                      | Narrower than Knip; focused specifically on `package.json` hygiene.                                                                               |
| **madge**      | Circular dependency detection            | Visualizes and detects dependency cycles — useful for catching broken module boundaries.                                                          |

### Git hooks & commit hygiene

| Tool            | Purpose                         | Status / notes                                                                                                                                                         |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Husky**       | Git hook manager                | The de facto standard for Node (~5M weekly downloads). Simple `.husky/` directory.                                                                                     |
| **lint-staged** | Run checks on staged files only | Companion to Husky; runs linters/formatters only on what you're committing, not the whole repo. The standard husky + lint-staged pairing remains the industry default. |
| **Lefthook**    | Git hook manager                | Go-based, runs hooks **in parallel**, ~10× faster than Husky on large projects. The all-in-one faster alternative.                                                     |
| **pre-commit**  | Git hook manager                | The standard in the Python ecosystem; language-agnostic.                                                                                                               |
| **commitlint**  | Commit message linting          | Enforces Conventional Commits, enabling automated changelogs and semantic versioning.                                                                                  |
| **Changesets**  | Versioning & changelogs         | Popular for managing versioning and release notes, especially in monorepos.                                                                                            |

### Testing

| Tool                          | Purpose                      | Status / notes                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vitest**                    | Unit / integration testing   | Now the dominant choice for greenfield (overtook Jest in developer satisfaction; ~400%+ growth since 2023). Native TS/ESM, Vite-powered speed, Jest-compatible API for easy migration. Recommended by Nuxt, SvelteKit, Astro, and modern Angular tooling. |
| **Jest**                      | Unit / integration testing   | Still enormous and battle-tested (Meta-maintained). CommonJS-first architecture makes ESM a second-class citizen; usage has plateaued but it remains a safe, well-supported choice for existing codebases.                                                |
| **Node built-in test runner** | Unit testing                 | Matured enough for real workloads; fills the zero-dependency, minimal-setup niche.                                                                                                                                                                        |
| **Playwright**                | End-to-end / browser testing | The current default for E2E (overtook Cypress in npm downloads). Cross-browser, fast, reliable auto-waiting.                                                                                                                                              |
| **Cypress**                   | End-to-end testing           | Still widely used with a strong DX; losing ground to Playwright.                                                                                                                                                                                          |
| **Testing Library**           | Component testing            | The standard companion for testing UI the way users interact with it (works with Vitest/Jest).                                                                                                                                                            |

### Security — SAST, secrets, supply chain

| Tool                                         | Purpose                         | Status / notes                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semgrep**                                  | SAST (+ secrets)                | Open-source, code-aware, custom-rule DSL; great PR-level developer feedback. The OSS SAST workhorse; paid AppSec Platform adds management.                                                              |
| **CodeQL**                                   | SAST                            | GitHub-native (treats code as a queryable database). Lowest-friction SAST if you're on GitHub Advanced Security; runs automatically on PRs.                                                             |
| **SonarQube / SonarCloud**                   | Code quality + security         | Combines bugs, code smells, complexity, and vulnerabilities in one platform with quality-gate enforcement. Strong enterprise fit; Community Edition is free.                                            |
| **Snyk**                                     | SCA + SAST + IaC + containers   | Market-leading developer-first scanning across dependencies, code, IaC, and images. Excellent DX; commercial.                                                                                           |
| **Gitleaks**                                 | Secret scanning                 | Fast regex-based scanner (150+ patterns); ideal as a pre-commit hook. OSS.                                                                                                                              |
| **TruffleHog**                               | Secret scanning                 | Detector-based with **800+ detectors** and live-credential **verification** (drastically cuts false positives). Strong on full git-history scanning. Common advice: run Gitleaks + TruffleHog together. |
| **detect-secrets**                           | Secret scanning                 | Good for establishing a baseline on a legacy codebase before ongoing scanning.                                                                                                                          |
| **GitHub Secret Scanning / Push Protection** | Secret scanning                 | Native; free on public repos, blocks known provider patterns at push time.                                                                                                                              |
| **OSV-Scanner**                              | SCA / dependency vulns          | Google's scanner against the OSV database; scans manifests and lockfiles across ecosystems.                                                                                                             |
| **Trivy**                                    | SCA + IaC + containers + SBOM   | Aqua's all-in-one scanner (absorbed `tfsec` for IaC). Very popular OSS choice covering many surfaces at once.                                                                                           |
| **Grype** / **Syft**                         | Vuln scanning / SBOM generation | Anchore's pair — Syft generates the SBOM, Grype scans it.                                                                                                                                               |
| **Checkov**                                  | IaC security                    | Scans Terraform, CloudFormation, CDK, Kubernetes for misconfigurations.                                                                                                                                 |

### Dependency updates

| Tool           | Purpose                         | Status / notes                                                                                                                                      |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renovate**   | Automated dependency update PRs | Increasingly the preferred choice over Dependabot — superior grouping, monorepo support, and configurability. Now common across major OSS projects. |
| **Dependabot** | Automated dependency update PRs | GitHub-native, zero-setup, also surfaces security advisories. Still excellent for simpler needs and tight GitHub integration.                       |
| **npm audit**  | Dependency vuln check           | Built into npm; a baseline first line of defense.                                                                                                   |

### Observability

| Tool                                                | Purpose                        | Status / notes                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenTelemetry (OTel)**                            | Vendor-neutral instrumentation | The industry standard for traces, metrics, and logs. Instrument once with OTel APIs and export (via OTLP) to _any_ backend — avoids lock-in. The right foundation to standardize on. |
| **Sentry**                                          | Error tracking + tracing       | Excellent error monitoring with rich context; now accepts OTLP traces, so it interoperates with OTel instrumentation.                                                                |
| **Grafana stack** (Loki / Tempo / Mimir-Prometheus) | Logs / traces / metrics        | Popular open-source, self-hostable observability backend — fits an EU-residency, self-hosted preference.                                                                             |
| **AWS CloudWatch + X-Ray**                          | Logs/metrics + tracing         | The AWS-native option (CloudWatch for logs/metrics, X-Ray for traces); integrates with OTel.                                                                                         |
| **Datadog**                                         | Full observability platform    | The full-featured commercial incumbent; powerful but costly at scale.                                                                                                                |

### Documentation & decision records

| Tool                          | Purpose                                    | Status / notes                                                                                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **MADR template / adr-tools** | Architecture Decision Records              | Lightweight markdown-based ADR conventions; `adr-tools` scaffolds them from the CLI.                          |
| **Log4brains**                | ADR management                             | Turns your ADRs into a searchable, browsable knowledge base.                                                  |
| **Storybook**                 | Component development & design-system docs | Develop, document, and visually test UI components in isolation — the backbone of a maintained design system. |
| **TypeDoc / Docusaurus**      | API & project docs                         | Generate reference docs from TypeScript; build documentation sites.                                           |

---

_A practical next step: take each row of Layer 1–5 and answer three questions — (1) what tool enforces it, (2) where does it run (editor / pre-commit / CI / branch protection), and (3) is it blocking or advisory. That table is, in effect, the quality contract your pipeline enforces on every change, human- or agent-authored._
