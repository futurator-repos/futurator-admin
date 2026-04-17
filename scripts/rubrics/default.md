# Global Default Review Rubric

Project-agnostic rules applied to every epic-dev review, regardless of project.
Daemon bootstrap copies this file to `/opt/futurator/rubrics/default.md` at
install time; the rubric-merge helper (`daemon/pipelines/lib/rubric-merge.mjs`)
composes this default with the project overlay at `.claude/review-rubric.md`.

Format contract (required by the unit test):

- Every rule is a level-2 heading of the form `## R-{CATEGORY}-{NNN} — {title}`.
- Immediately under each heading, a `- **Rule**: ` line states the rule in one sentence.
- Immediately after that, a `- **Rationale**: ` line explains why the rule exists.
- Additional bullets (scope, examples, severity) are optional and do not affect parsing.

Categories:

- **CORR** — correctness: does the diff implement what the story asked, without regressions?
- **CONV** — conventions: does the diff match established repo style and idioms?
- **TEST** — tests: is the change covered and does the suite pass?
- **MAINT** — maintainability: is the diff readable, small, and free of dead code?
- **SEC** — security: does the diff avoid common security pitfalls?

---

## R-CORR-001 — Story acceptance criteria are satisfied

- **Rule**: Every Given/When/Then bullet in the story's AC maps to observable behavior in the diff or accompanying tests.
- **Rationale**: Reviews exist to verify the story goal was met — not to rubber-stamp code that compiles.

## R-CORR-002 — No TODO or placeholder logic in the happy path

- **Rule**: Reject `TODO`, `FIXME`, `throw new Error('not implemented')`, or stubbed branches that are reachable on the documented happy path.
- **Rationale**: Half-finished code that types-checks still ships bugs; catch it at review.

## R-CORR-003 — No silent catch-and-ignore

- **Rule**: Reject `catch (_) {}`, `catch { /* ignore */ }`, or promise chains that swallow rejections without logging or propagating.
- **Rationale**: Swallowed errors produce ghost failures that are expensive to diagnose in production.

## R-CORR-004 — Null/undefined checks at real boundaries only

- **Rule**: Reject defensive checks against values that cannot be null per the surrounding type system; require checks at external boundaries (user input, third-party APIs, DDB reads) where null is actually possible.
- **Rationale**: Noise degrades signal; only real boundaries deserve guards.

## R-CORR-005 — Do not introduce retries or timeouts without a defined budget

- **Rule**: Any new retry loop or timeout must specify an explicit max attempt count, backoff, and failure path; unbounded retries are rejected.
- **Rationale**: Unbounded retries amplify outages and hide root causes.

## R-CORR-006 — No accidental behavioral changes to touched-but-not-targeted code

- **Rule**: Lines changed outside the story's stated touch points must be necessary to land the story; cosmetic rewrites or drive-by refactors are rejected.
- **Rationale**: Scope creep during reviews is the leading cause of regressions in unrelated features.

---

## R-CONV-001 — Match surrounding naming and structure

- **Rule**: New files, exports, and identifiers adopt the naming, casing, and directory structure already in use adjacent to the diff.
- **Rationale**: Idiomatic code is cheaper to read, reason about, and grep.

## R-CONV-002 — Prefer existing helpers to new abstractions

- **Rule**: If a helper already exists that accomplishes the goal, reject new duplicate helpers; update or extend the existing one.
- **Rationale**: Duplicate helpers fragment the codebase and produce inconsistent behavior over time.

## R-CONV-003 — No dead or unused exports

- **Rule**: Every new export must be imported by at least one callsite in the same PR; reject exports that are declared "for later".
- **Rationale**: Dead exports accumulate and confuse both humans and dependency tooling.

## R-CONV-004 — Keep comments WHY-focused

- **Rule**: Reject comments that describe WHAT the code does when the code already reads as its own explanation; keep comments that explain non-obvious constraints, workarounds, or invariants.
- **Rationale**: WHAT-comments rot; WHY-comments earn their keep.

## R-CONV-005 — Match the commit message style of the repo

- **Rule**: Commit subjects follow the verb-first conventional-commit-or-similar style already in the repo's `git log`; reject sloppy or unrelated messages.
- **Rationale**: Consistent history makes `git log` and `git blame` useful.

## R-CONV-006 — Imports ordered and minimal

- **Rule**: Reject imports that are unused, mixed between side-effect and symbol imports without reason, or that bypass an existing path alias.
- **Rationale**: Clean import blocks catch refactor leftovers.

---

## R-TEST-001 — New pure logic ships with unit tests

- **Rule**: Pure functions and data transforms introduced in the diff must have a matching unit test covering at least one happy path plus one boundary or failure case.
- **Rationale**: Pure logic is the cheapest place to catch regressions; leaving it untested wastes the easy win.

## R-TEST-002 — I/O-heavy modules have an integration test or explicit waiver

- **Rule**: Modules that orchestrate child processes, network calls, or DB writes must add or extend an integration test, or the PR description must explain why one is impractical.
- **Rationale**: These are the modules that break in production; a waiver at review time forces a deliberate decision.

## R-TEST-003 — Tests do not depend on timing or unseeded randomness

- **Rule**: Reject tests that rely on real-clock `setTimeout`, current time, or unseeded `Math.random()`; use fake timers or seeded RNGs.
- **Rationale**: Flaky tests erode trust in the suite and eventually get disabled.

## R-TEST-004 — Changed behavior has at least one assertion on the new behavior

- **Rule**: If the diff changes an externally visible behavior, at least one test must assert the new behavior specifically (not just compile-time shape).
- **Rationale**: Green tests that don't exercise the change prove nothing.

## R-TEST-005 — No xit / skip / only left in merged tests

- **Rule**: Reject `it.only`, `describe.only`, `xit`, `xdescribe`, or commented-out test bodies.
- **Rationale**: Accidental "only" turns a CI run into a no-op; skipped tests are silent rot.

---

## R-MAINT-001 — Functions stay small and single-purpose

- **Rule**: New functions longer than roughly 75 lines or doing more than one clearly-named thing must be refactored or explicitly justified.
- **Rationale**: Long, multi-purpose functions are the most common cause of future bugs.

## R-MAINT-002 — No premature abstraction

- **Rule**: Reject new base classes, generic adapters, or config objects introduced to serve fewer than three present-day callers.
- **Rationale**: Designing for hypothetical futures freezes options in the wrong shape.

## R-MAINT-003 — No dead code or commented-out blocks

- **Rule**: Reject commented-out code, unreachable branches, and leftover debug logging.
- **Rationale**: Dead code obscures intent and invites cargo-cult maintenance.

## R-MAINT-004 — No over-broad catch blocks

- **Rule**: `catch` clauses catch the narrowest error type possible; generic `catch (err)` must log and rethrow unless the function contract explicitly requires swallowing.
- **Rationale**: Broad catches erase stack traces and mask upstream bugs.

## R-MAINT-005 — Logs carry enough context to diagnose

- **Rule**: Error and warn logs must include at least: the operation name, the key identifier (jobId, epicId, storyId, userId where applicable), and a short error descriptor.
- **Rationale**: Logs without identifiers are impossible to correlate at scale.

## R-MAINT-006 — Public functions and types have a one-line intent doc

- **Rule**: Every new exported function or type exposed across module boundaries has a single-line JSDoc or comment describing intent (not implementation).
- **Rationale**: One-liners at module boundaries cut onboarding time dramatically.

---

## R-SEC-001 — No hardcoded secrets, tokens, or credentials

- **Rule**: Reject literals matching `sk-*`, `AKIA[A-Z0-9]{16}`, `AWS_SECRET_ACCESS_KEY=`, Bearer tokens, or `.env` content in the diff.
- **Rationale**: Secrets in diffs travel everywhere the diff travels — revocation is expensive.

## R-SEC-002 — Input validation at trust boundaries

- **Rule**: Handlers for user input, webhooks, CLI args, or external APIs must validate shape and type before use; reject raw `JSON.parse(body)` flowed directly into business logic.
- **Rationale**: Untyped input at the boundary is the root cause of most injection and crash bugs.

## R-SEC-003 — No string interpolation into shell, SQL, or query constructs

- **Rule**: Reject template-string interpolation into `exec`, `execSync`, `spawn` shell strings, raw SQL, or DB query expressions; use argv arrays or parameterized APIs.
- **Rationale**: Command and query injection is still the easiest mistake to ship.

## R-SEC-004 — Authorization checks on privileged operations

- **Rule**: Any new handler that reads or mutates user-scoped data must call the same auth middleware used by sibling handlers; reject routes that rely on "it's behind CloudFront" or similar perimeter defenses.
- **Rationale**: Broken access control is the most common web vulnerability class.

## R-SEC-005 — Timing-insensitive comparisons for secrets

- **Rule**: Reject `===` comparisons on tokens, HMAC signatures, or other secret-equivalent strings; use constant-time comparison helpers.
- **Rationale**: Timing oracles leak secrets under sustained attack.

## R-SEC-006 — No eval, Function(), or dynamic-require of user input

- **Rule**: Reject `eval()`, `new Function(userInput)`, and `require(userInput)` patterns.
- **Rationale**: Dynamic code from user-controlled data is arbitrary remote code execution.
