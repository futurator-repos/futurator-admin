# Data Privacy Assessment — quality analysis + change requests for the privacy agent

> Hand this to the agent that owns `data-privacy-platform`. Context: the Futurator
> Assess tab runs your `privacy-recon.mjs` on the EC2 clone and renders findings.
> First real run on `applicator`: **9,738 findings** (GDPR 7,803 · EU AI Act 1,935)
> across 1,498 scanned files. We've already fixed the _consumption_ side
> (category-first rollups); these requests fix the _source_ quality so the lane is
> trustworthy and cheap.

## What the data actually looks like

The scanner emits **one finding per (category × file)** — it's not 9,738 distinct
problems, it's **12 GDPR + 5 EU AI Act categories**, each matching a large fraction
of all files:

| Category                             | Files matched | of 1,457 | Severity     |
| ------------------------------------ | ------------- | -------- | ------------ |
| Re-identification by Linkage         | 1,243         | 85%      | high         |
| k-Anonymity                          | 1,146         | 79%      | high         |
| Where Does Your Data Physically Live | 1,089         | 75%      | high         |
| PII in Logs                          | 864           | 59%      | high         |
| Emotion Inference at Work            | 652           | 45%      | **critical** |
| Encryption at Rest                   | 581           | 40%      | high         |
| …                                    |               |          |              |
| Password Storage                     | 497           | 34%      | **critical** |
| Automated Decisions                  | 327           | 22%      | **critical** |
| Proxy Discrimination in AI           | 86            | 6%       | **critical** |

When a category matches **85% of all files**, it's not a finding — it's a
keyword that's everywhere. The signal-to-noise is low.

## Change requests (highest value first)

### CR-1 — Scope excludes (biggest noise cut)

The scan includes non-application files that can't process personal data:

- `_bmad/**` (agent/prompt definitions — `ludwig.agent.yaml` flagged for "Automated Decisions")
- `docs/**` (concept docs, `.jsx`/`.tsx` demos, `docs/qa/gates/*.yml`)
- `*.yaml` / `*.yml` config, `*.md`
- test/spec/fixture/mock files, generated code, vendored deps

**Ask:** exclude these by default (with an override flag). Likely removes a large
share of the 9.7k.

### CR-2 — Category-aggregated output mode

Returning 9,738 line-level findings makes every client re-aggregate 10k rows. We
already collapse them to ~17 categories on our side, but it'd be cleaner + much
smaller over the wire if the service offered it natively.

**Ask:** a `?group=category` mode (or a `by_category` block) returning per-category
rollups: `{ category, regulation, severity, fileCount, fileScoreHistogram,
topFiles:[{file,score}], remediation, citation, card }`. Keep raw per-finding
available behind a flag for deep export.

### CR-3 — Meaningful confidence / score

Today `confidence` is ~0.95 flat and scores cluster (95 / 71). With "matched
signals: output, produce, significant" a comment or a variable named `decision`
scores the same as real auth code.

**Ask:** weight the score by (a) number of _distinct strong_ signals, (b) whether
the match is in executable code vs comment/string/markdown, (c) proximity to
actual PII handling (DB writes, network calls, logging). Surface the matched
signals + line so a reviewer can judge.

### CR-4 — Per-file dedup (confirm)

We observed ~1 finding per (category, file) already — good. Please keep it that
way (don't emit per-line duplicates within a file).

### CR-5 — Self-describing titles

`title` is currently a long question ("Does a model output produce a legal or
significant effect…"). For list rendering we need a short label (the category is
fine) + the specific file + the matched signal. The question is great as the
expanded detail, not the row title.

## What we already did on our side (so you can see the target shape)

`summarizePrivacyReport` (daemon) now groups your raw findings into a category-first
summary the UI renders: per regulation → categories sorted critical-first then by
breadth, each with `fileCount`, severity counts, the shared remediation/citation,
and the top-20 worst files by score. The full raw report is archived to S3 for
deep audit. CR-1/CR-3 are what would make those categories _trustworthy_; CR-2 just
makes it cheaper.

## Out of scope here (our follow-up, not yours)

An optional **L3 adjudication** pass: an LLM agent reads the top files in each of
the ~17 categories and confirms/rejects "is this a real concern or keyword noise?",
citing your rule cards via the MCP endpoint. That's our side; your CR-1/CR-3 make
it far more accurate by feeding it fewer false positives.
