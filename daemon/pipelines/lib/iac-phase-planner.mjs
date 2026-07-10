// iac-phase-planner.mjs — Refactoring Scan Engine v2, the Infrastructure MIGRATION
// track (design Part B). Pure JS, ~0 LLM, FILE-FIRST, REPORT-ONLY.
//
// Turns the deterministic `inventory.iacMaturity` grade (attached by infra-extract)
// into a gap-driven, STACK-AWARE phased plan (`iacPlan`) that maps the rubric's
// MISSING dimensions onto the iac-migration.md Phase 0–8 playbook. Only emits steps
// for dimensions that are NOT yet satisfied — a repo that already has remote state
// skips the import phase, a repo with policy-as-code skips the governance phase.
//
// SAFETY (non-negotiable, mirrors the doc's non-goals):
//   - We NEVER recommend running terraform/pulumi/aws live against the clone (needs
//     creds). Every mutating step carries the GOLDEN RULE — plan/preview must show
//     ZERO changes before commit — the IaC analogue of our characterization-test gate.
//   - Terraformer is a one-shot reverse-engineering utility, NEVER a pipeline step
//     (archived Mar 16 2026); we never emit it as a recurring command.
//
// Import ordering: seeded from what the scan ALREADY detects — every
// `iacCoverage.undeclared` service + every `deployScripts` entry becomes an import
// target, PRIORITISED by graph fan-in × git churn (stateful + hot + widely-reached
// resources adopt first). fanIn comes from services[].fanIn (enrichInfraWithGraph);
// churn from the Git & Evolution report (churnByFile / hotFiles).

export const LEVEL_NAMES = ['ClickOps', 'Repeatable', 'Defined', 'Managed', 'Optimizing'];

// ── Stack-aware tooling. Each tool exposes concrete, non-live command sets keyed by
// the rubric dimension it satisfies. `state` also seeds the import list. ──
const GOLDEN = {
  pulumi: '`pulumi preview` must show no changes before you commit.',
  terraform: '`terraform plan` must show "No changes" before you commit.',
  opentofu: '`tofu plan` must show "No changes" before you commit.',
  cdk: '`cdk diff` must show no changes before you commit.',
  sst: '`sst diff` must show no changes before you deploy.',
  'gcp-im':
    '`terraform plan` (Infrastructure Manager preview) must show "No changes" before you commit.',
};

const TOOLING = {
  pulumi: {
    state: [
      'pulumi login s3://<state-bucket>   # managed/remote backend (or Pulumi Cloud)',
      'pulumi import --file resources.json   # bulk-adopt existing resources ({type,name,id}[])',
      'pulumi preview   # MUST show no changes; imported resources are `protect`-ed by default',
    ],
    envSeparation: [
      'pulumi stack init dev && pulumi stack init staging && pulumi stack init prod   # per-env stacks + Pulumi.<stack>.yaml',
    ],
    modularity: [
      '# extract shared infra into ComponentResource classes / a shared @org/infra package',
    ],
    testing: [
      '# Pulumi unit tests: pulumi.runtime.setMocks(...) + jest/mocha; wire as a required CI check',
    ],
    governance: [
      'pulumi policy new <pack> --language typescript   # CrossGuard: require tags, pin region, deny public buckets (advisory → mandatory)',
    ],
    driftCost: [
      'pulumi preview --expect-no-changes   # schedule via GitHub Actions cron (drift detection)',
    ],
    cost: ['# add Infracost PR diff comments to the CI plan step'],
  },
  terraform: {
    state: [
      '# backend.tf: terraform { backend "s3" { bucket = ...; dynamodb_table = ... } }   # remote + locked state',
      '# add import {} blocks, then: terraform plan -generate-config-out=generated.tf',
      'terraform apply && terraform plan   # MUST show "No changes"; then delete the import blocks',
      '# NOTE: Terraformer is a one-shot bulk export only (archived Mar 16 2026) — NEVER a pipeline step',
    ],
    envSeparation: [
      '# split state per env: environments/{dev,staging,prod}/ (or terraform workspace) with per-env *.tfvars',
    ],
    modularity: [
      '# extract modules/ with PINNED sources (version = / ?ref=); replace the root-monolith resources',
    ],
    testing: [
      '# native tests: *.tftest.hcl (terraform test) + terraform fmt/validate as required CI checks',
    ],
    governance: [
      'checkov -d . --compact   # + `trivy config .`; start advisory, promote to mandatory',
    ],
    driftCost: [
      '# scheduled `terraform plan` in CI (drift detection — the infra analogue of spec-drift)',
    ],
    cost: ['# Infracost PR diff (infracost.yml) gating cost on PR'],
  },
  opentofu: {
    state: [
      '# backend.tf: terraform { backend "s3" { bucket = ...; use_lockfile = true } }   # remote + locked state',
      '# add import {} blocks, then: tofu plan -generate-config-out=generated.tf',
      'tofu apply && tofu plan   # MUST show "No changes"; then delete the import blocks',
      '# NOTE: Terraformer is a one-shot bulk export only (archived Mar 16 2026) — NEVER a pipeline step',
    ],
    envSeparation: [
      '# split state per env: environments/{dev,staging,prod}/ (or tofu workspace) with per-env *.tfvars',
    ],
    modularity: [
      '# extract modules/ with PINNED sources (version = / ?ref=); replace the root-monolith resources',
    ],
    testing: ['# native tests: *.tftest.hcl (tofu test) + tofu fmt/validate as required CI checks'],
    governance: [
      'checkov -d . --compact   # + `trivy config .`; start advisory, promote to mandatory',
    ],
    driftCost: ['# scheduled `tofu plan` in CI (drift detection)'],
    cost: ['# Infracost PR diff (infracost.yml) gating cost on PR'],
  },
  cdk: {
    state: [
      'cdk migrate --stack-name <name> --from-scan new   # generate a CDK app from deployed resources',
      '# or wrap existing CFN with CfnInclude; adopt one-off resources with: cdk import',
      'cdk diff   # MUST show no changes; WARN: check RemovalPolicy defaults so stateful resources are not destroyed',
    ],
    envSeparation: [
      '# separate stacks per env via Stage constructs / cdk.context (dev/staging/prod)',
    ],
    modularity: ['# extract reusable L3 Constructs / a constructs library'],
    testing: ['# CDK assertions (aws-cdk-lib/assertions) + snapshot tests wired into CI'],
    governance: [
      'checkov -d cdk.out --compact   # scan synthesized templates; + org policy (advisory → mandatory)',
    ],
    driftCost: ['# scheduled `cdk diff` in CI (drift detection)'],
    cost: ['# Infracost on the synthesized CloudFormation'],
  },
  sst: {
    state: [
      '# SST manages remote state via its own backend — no manual state bootstrap needed',
      '# adopt existing resources in sst.config.ts (SST runs on Pulumi under the hood): use { transform } / the import option',
      'sst diff   # MUST show no changes before you deploy',
    ],
    envSeparation: [
      'sst deploy --stage dev|staging|production   # per-stage isolation is built in',
    ],
    modularity: ['# extract infra into infra/*.ts modules imported by sst.config.ts'],
    testing: ['# unit-test infra modules (vitest) + `sst diff` as a required CI check'],
    governance: [
      '# add a Pulumi CrossGuard pack (SST runs on Pulumi under the hood) / checkov on synthesized templates',
    ],
    driftCost: ['# scheduled `sst diff` (drift detection); SST reconciles on deploy'],
    cost: ['# Infracost / SST Console cost estimates gating PRs'],
  },
  'gcp-im': {
    state: [
      '# Infrastructure Manager (Google-managed Terraform) + a GCS state backend',
      'config-connector bulk-export --project <p> --output bulk-export.yaml   # or `gcloud asset export` → import {} blocks',
      'terraform plan   # MUST show "No changes" before you commit',
    ],
    envSeparation: ['# per-env projects/state; bootstrap with Cloud Foundation Fabric FAST'],
    modularity: ['# adopt CFT modules / Cloud Foundation Fabric reference architectures'],
    testing: ['# terraform test + `gcloud terraform vet` in CI'],
    governance: ['# Policy Controller / `gcloud terraform vet` + Checkov; advisory → mandatory'],
    driftCost: ['# Infrastructure Manager preview deployments surface drift (schedule them)'],
    cost: ['# Infracost PR diff on the Terraform plan'],
  },
};

// ── Dimension → migration-phase mapping (iac-migration.md A.1). Ordered foundations-
// first: state (import) → env/modularity (refactor) → testing → drift/cost → policy. ──
const DIMENSION_SPECS = [
  {
    dim: 'state',
    phase: 2,
    title: 'Remote state & resource import',
    keys: ['state'],
    mutating: true,
    seedImports: true,
    why: 'Get every running resource into remote, locked, version-controlled state — the Level 1→2 boundary everything else builds on.',
  },
  {
    dim: 'envSeparation',
    phase: 3,
    title: 'Environment separation',
    keys: ['envSeparation'],
    mutating: true,
    why: 'Isolate dev/staging/prod state so a change to one environment can never clobber another.',
  },
  {
    dim: 'modularity',
    phase: 3,
    title: 'Refactor to reusable modules',
    keys: ['modularity'],
    mutating: true,
    why: 'Generated/monolithic infra is a starting point — extract DRY, pinned modules so it stays maintainable.',
  },
  {
    dim: 'testing',
    phase: 4,
    title: 'IaC testing',
    keys: ['testing'],
    mutating: false,
    why: 'Static validation + unit tests as required CI checks — the infrastructure TDD layer.',
  },
  {
    dim: 'driftCost',
    phase: 5,
    title: 'Drift detection & cost gate',
    keys: ['driftCost', 'cost'],
    mutating: false,
    why: 'Add a scheduled plan/preview (drift detection — the infra analogue of a spec-conformance check) and wire a cost estimate to gate PRs.',
  },
  {
    dim: 'governance',
    phase: 6,
    title: 'Policy-as-code guardrails',
    keys: ['governance'],
    mutating: false,
    why: 'Misconfig scanning + org policy — start advisory, promote to mandatory.',
  },
];

/**
 * Resolve the stack-aware IaC tool key from the infra inventory (which providers were
 * declared) with the Stack Profile as a secondary hint. Returns one of
 * pulumi|terraform|opentofu|cdk|sst|gcp-im. A cdktf-only repo maps to `terraform`
 * (its tooling target) since CDKTF itself is archived (handled as a deprecation).
 */
export function detectStackTool(inventory, stack = null) {
  const providers = (
    (inventory && inventory.summary && inventory.summary.iacProviders) ||
    (inventory && Array.isArray(inventory.iac) ? inventory.iac.map((i) => i.provider) : []) ||
    []
  ).map((p) => String(p || '').toLowerCase());
  const clouds = ((inventory && inventory.clouds) || []).map((c) => String(c || '').toLowerCase());
  const deprecated = (inventory && inventory.iacMaturity && inventory.iacMaturity.deprecated) || [];
  const depTools = deprecated.map((d) => String((d && d.tool) || '').toLowerCase());
  const has = (needle) => providers.some((p) => p.includes(needle));
  const dep = (needle) => depTools.some((t) => t.includes(needle));

  const gcpPrimary = clouds.includes('gcp') && !clouds.includes('aws');

  if (has('pulumi')) return 'pulumi';
  if (has('sst')) return 'sst';
  // AWS CDK (but NOT "terraform cdk"/cdktf, which routes to terraform tooling).
  if (has('cdk') && !has('terraform cdk')) return 'cdk';
  // GCP Deployment Manager is EOL — its migration target is Infrastructure Manager.
  if (dep('deployment manager') || dep('deployment-manager')) return 'gcp-im';
  if (has('terraform') || has('terragrunt') || has('opentofu') || has('terraform cdk')) {
    return gcpPrimary ? 'gcp-im' : 'terraform';
  }
  if (gcpPrimary) return 'gcp-im';
  // No IaC declared at all → default recommendation follows the primary cloud.
  return 'terraform';
}

/** churn count for a file from the Git & Evolution report (churnByFile or hotFiles). */
function churnOf(gitEvolution, file) {
  if (!gitEvolution || !file) return 0;
  if (gitEvolution.churnByFile && typeof gitEvolution.churnByFile[file] === 'number')
    return gitEvolution.churnByFile[file];
  if (Array.isArray(gitEvolution.hotFiles)) {
    const h = gitEvolution.hotFiles.find((x) => x && x.file === file);
    if (h && typeof h.churn === 'number') return h.churn;
  }
  return 0;
}

// Rank a file by how good an ADOPTION SOURCE it is — where the resource is actually
// DEFINED, not merely referenced. Generic, no repo-specific paths: an IAM policy only
// proves the resource is granted (not where it lives); a docs/example/demo file is never
// the thing you adopt; a hand-rolled deploy script IS the click-ops artifact you replace.
function sourceRank(f) {
  const s = String(f || '').toLowerCase();
  if (!s) return -2;
  if (
    /(^|\/)(docs?|concepts?|examples?|samples?|demos?|fixtures?)\//.test(s) ||
    /(^|\/)readme/.test(s)
  )
    return -1; // documentation/demo — never the file you adopt from
  if (/(trust[-_]?)?policy\.json$/.test(s) || /(^|\/)iam[-_/]/.test(s)) return 0; // IAM policy: proves the resource is REFERENCED, not where it's defined
  if (/\.(sh|bash)$/.test(s)) return 3; // hand-rolled deploy script = the exact artifact to replace with IaC
  if (/(^|\/)(infra|stacks?|deploy)\//.test(s) || /(^|\/)sst\.config|\.tf$|pulumi\./.test(s))
    return 2; // infra config that touches it
  return 1; // application code that references the resource
}
function bestSource(files) {
  const ranked = [...new Set(files || [])]
    .filter(Boolean)
    .sort((a, b) => sourceRank(b) - sourceRank(a) || String(a).localeCompare(String(b)));
  return ranked.find((f) => sourceRank(f) >= 0) || ranked[0] || null;
}

/**
 * Seed the import list from what the scan already detects: every undeclared
 * provisionable service + every hand-rolled deploy script. priority = fanIn × churn
 * (multiplier is 1 when no git history is available, so ordering degrades to fanIn).
 *
 * Two structural rules (keep/retire classifier + honest sourcing):
 *   - A resource flagged `orphanCandidate` (a code-readable retire/legacy/deprecated
 *     signal near it) is NEVER an import target — you don't codify infra you're deleting.
 *     It is routed to `retire[]` instead. This is what stops the plan from telling you to
 *     adopt a being-retired store.
 *   - Each import's `source` is the best DEFINING file (deploy script > infra config >
 *     app code > IAM policy > docs), not just the alphabetically-first file it was seen in.
 * Imports are DEDUPED by resource so a service provisioned by 3 scripts is one entry.
 *
 * @returns {{ imports: Array, retire: Array }}
 */
function buildImports(inventory, gitEvolution) {
  const hasGit = !!(gitEvolution && (gitEvolution.churnByFile || gitEvolution.hotFiles));
  const servicesByName = new Map((inventory.services || []).map((s) => [s.name, s]));
  const iacCoverage = inventory.iacCoverage || {};
  const deployScripts = inventory.deployScripts || [];
  const isOrphan = (name) =>
    !!(servicesByName.get(name) && servicesByName.get(name).orphanCandidate);

  const byResource = new Map(); // resource -> {resource, source, priority}
  const retire = [];
  const seenRetire = new Set();
  // Final-iteration item 5 — retire sequencing needs a KIND per entry to order teardown
  // generically (compute before messaging before IAM; a data-store kind is never
  // auto-sequenced — see buildRetireSequence). Real services resolve via servicesByName;
  // provision-label pseudo-resources (Lambda/IAM/iam-policy — never real service entries,
  // see buildImports' deployScripts loop) fall back to a small generic name hint.
  const kindOfRetire = (resource) => {
    const svc = servicesByName.get(resource);
    if (svc && svc.kind) return svc.kind;
    return RETIRE_KIND_HINT[String(resource || '').toLowerCase()] || 'unknown';
  };
  const addRetire = (resource, reason, source) => {
    if (!resource || seenRetire.has(resource)) return;
    seenRetire.add(resource);
    retire.push({ resource, reason, source: source || null, kind: kindOfRetire(resource) });
  };
  const addImport = (resource, source, priority) => {
    const cur = byResource.get(resource);
    if (!cur) {
      byResource.set(resource, {
        resource,
        source: source || 'inferred-from-usage (declared in no IaC file)',
        priority,
      });
      return;
    }
    cur.priority = Math.max(cur.priority, priority);
    if (sourceRank(source) > sourceRank(cur.source)) cur.source = source;
  };

  for (const name of iacCoverage.undeclared || []) {
    const svc = servicesByName.get(name);
    if (svc && svc.orphanCandidate) {
      addRetire(
        name,
        svc.orphanReason || 'retirement signal found in code',
        bestSource(svc.files || []),
      );
      continue; // never adopt a resource the code says is being retired
    }
    const fanIn = svc && typeof svc.fanIn === 'number' ? svc.fanIn : 1;
    const svcFiles = svc && Array.isArray(svc.files) ? svc.files : [];
    const scriptFiles = deployScripts
      .filter((ds) => (ds.provisions || []).includes(name))
      .map((ds) => ds.file);
    const churn = [...new Set([...svcFiles, ...scriptFiles])].reduce(
      (acc, f) => acc + churnOf(gitEvolution, f),
      0,
    );
    addImport(name, bestSource([...scriptFiles, ...svcFiles]), fanIn * (hasGit ? churn : 1));
  }

  for (const ds of deployScripts) {
    const provisions = (ds.provisions || []).filter(Boolean);
    const churn = churnOf(gitEvolution, ds.file);
    // a script that provisions ONLY retiring resources is itself retire-not-adopt.
    if (provisions.length && provisions.every(isOrphan)) {
      addRetire(provisions.join(', '), 'hand-rolled deploy of retiring resource(s)', ds.file);
      continue;
    }
    let fanIn = 1;
    for (const p of provisions) {
      const svc = servicesByName.get(p);
      if (svc && !svc.orphanCandidate && typeof svc.fanIn === 'number' && svc.fanIn > fanIn)
        fanIn = svc.fanIn;
    }
    const priority = fanIn * (hasGit ? churn : 1);
    const targets = provisions.filter((p) => !isOrphan(p));
    // attribute the script to each concrete service it provisions (dedupes with the loop
    // above via the Map); a script that names no service keeps one generic entry.
    if (targets.length) for (const p of targets) addImport(p, ds.file, priority);
    else if (!provisions.length) addImport(ds.kind || 'resources', ds.file, priority);
  }

  // Stack co-location: a retirement note usually names ONE resource (the data store), but
  // the compute/queue/IAM sitting in the SAME stack directory are the same retiring unit —
  // adopting them is still "codify what you're deleting". Propagate retire to any adopt
  // target whose defining file lives under a retiring stack dir. Depth-gated (dir must be
  // >=2 levels deep) so a note in a shared root (scripts/, src/, or the repo root) can
  // never tar the whole repo — only a specific leaf stack like infra/lambda/graph-sync/.
  const retiringDirs = new Set();
  const retiringTokens = new Set(); // distinctive leaf stack-dir names (e.g. "graph-sync")
  for (const r of retire) {
    const d = stackDirOf(r.source);
    if (!d) continue;
    retiringDirs.add(d);
    // the leaf dir name also names the stack — a sibling deploy script like
    // "deploy-graph-sync-lambda.sh" (in a shared scripts/ dir the dir-rule can't reach)
    // still belongs to it. Guarded: >=6 chars and not a generic container name.
    const base = (d.split('/').pop() || '').toLowerCase();
    if (base.length >= 6 && !GENERIC_STACK_DIRS.has(base)) retiringTokens.add(base);
  }
  if (retiringDirs.size || retiringTokens.size) {
    for (const [resource, im] of [...byResource]) {
      const src = String(im.source || '');
      const d = stackDirOf(src);
      const inDir = d && [...retiringDirs].some((rd) => d === rd || d.startsWith(`${rd}/`));
      const tokenHit = !inDir && [...retiringTokens].some((t) => src.toLowerCase().includes(t));
      if (inDir || tokenHit) {
        byResource.delete(resource);
        addRetire(
          resource,
          inDir
            ? `co-located in a retiring stack (${d})`
            : 'part of a retiring stack (deploy artifact names it)',
          im.source,
        );
      }
    }
  }

  return {
    imports: [...byResource.values()].sort(
      (a, b) => b.priority - a.priority || String(a.resource).localeCompare(String(b.resource)),
    ),
    retire,
  };
}

// The specific stack directory a file belongs to, or null if it is too shallow to be a
// distinct stack (repo root or a single shared dir like scripts/ — where a retirement
// note must NOT propagate to unrelated resources). `a/b/file` → `a/b`; `scripts/x` → null.
function stackDirOf(file) {
  const parts = String(file || '').split('/');
  if (parts.length < 3) return null;
  return parts.slice(0, -1).join('/');
}
// Provision-label pseudo-resources (never real `services[]` entries — see the
// deployScripts loop above) get a generic kind hint so retire-sequencing can order them.
const RETIRE_KIND_HINT = {
  lambda: 'compute',
  function: 'compute',
  iam: 'iam',
  'iam-policy': 'iam',
  role: 'iam',
  policy: 'iam',
  sqs: 'messaging',
  sns: 'messaging',
  queue: 'messaging',
  dlq: 'messaging',
  topic: 'messaging',
};

// Final-iteration item 5 — safe teardown ORDER for the retire[] set: disable triggers
// feeding the retiring compute, then compute, then messaging/queues, then monitoring,
// then IAM last (roles/policies are commonly still referenced elsewhere until the very
// end). A database/storage/unknown-kind entry (e.g. a shared, not-Mycelium-owned EC2/DB)
// is NEVER auto-sequenced — deleting a data store is always a separate human decision,
// surfaced instead as `excludedFromSequencing`. Purely a generic, kind-based ordering
// template (like the TOOLING command lists) — not derived per-repo beyond the retire set.
const RETIRE_SEQ_RANK = { compute: 1, messaging: 2, iam: 3 };
function buildRetireSequence(retireWithKind) {
  if (!retireWithKind || !retireWithKind.length) return null;
  const sequenced = retireWithKind
    .filter((r) => RETIRE_SEQ_RANK[r.kind] != null)
    .sort(
      (a, b) =>
        RETIRE_SEQ_RANK[a.kind] - RETIRE_SEQ_RANK[b.kind] || a.resource.localeCompare(b.resource),
    );
  const excludedFromSequencing = retireWithKind
    .filter((r) => RETIRE_SEQ_RANK[r.kind] == null)
    .map((r) => ({
      resource: r.resource,
      kind: r.kind,
      note: 'not auto-sequenced — deleting a data store (or an unrecognized-kind resource) is a separate human decision, not a template step. If shared/owned elsewhere, it may not be yours to delete at all.',
    }));
  const computeNames = sequenced.filter((r) => r.kind === 'compute').map((r) => r.resource);
  const messagingNames = sequenced.filter((r) => r.kind === 'messaging').map((r) => r.resource);
  const iamNames = sequenced.filter((r) => r.kind === 'iam').map((r) => r.resource);
  const steps = [];
  if (computeNames.length) {
    steps.push({
      order: steps.length + 1,
      action:
        'Disable event-source-mappings / stream subscriptions / triggers feeding the retiring compute — stops new invocations without deleting state.',
    });
    steps.push({ order: steps.length + 1, action: `Delete compute: ${computeNames.join(', ')}.` });
  }
  if (messagingNames.length)
    steps.push({
      order: steps.length + 1,
      action: `Delete messaging/queue resources: ${messagingNames.join(', ')} — confirm the DLQ-depth verification-backlog item first (a nonzero depth means unprocessed work, not just dead infra).`,
    });
  if (computeNames.length || messagingNames.length)
    steps.push({
      order: steps.length + 1,
      action: 'Delete/disable any alarms or monitoring wired to the retiring stack.',
    });
  if (iamNames.length)
    steps.push({
      order: steps.length + 1,
      action: `Delete IAM roles/policies LAST, once nothing else references them: ${iamNames.join(', ')}.`,
    });
  if (!steps.length && !excludedFromSequencing.length) return null;
  return {
    steps,
    ...(excludedFromSequencing.length ? { excludedFromSequencing } : {}),
  };
}

// Generic container dir names that do NOT distinctively name a stack — a retirement note
// under one of these must never propagate to siblings by name alone.
const GENERIC_STACK_DIRS = new Set([
  'lambda',
  'lambdas',
  'common',
  'shared',
  'infra',
  'stacks',
  'stack',
  'deploy',
  'scripts',
  'functions',
  'source',
  'services',
  'modules',
  'config',
  'resources',
]);

// ── Final-iteration items 1–3: the plan's DEFINITION OF DONE is a concrete artifact
// set + a machine-readable manifest, not just a maturity level. ──

// The manifest STANDARD (item 2) — one fixed schema, same shape for every app/tool, so
// any consumer (FinOps/privacy/policy) reads one contract regardless of what codified the
// resource. Generated from IaC state + a live reconcile, NEVER hand-authored — this scan
// is code-only, so it can only emit the schema + a code-derived PREVIEW (see
// buildManifestPreview): `arn`/`depends_on`/live tags are honestly left unresolved here,
// not fabricated.
export const MANIFEST_SCHEMA = {
  version: '1',
  description:
    'Canonical, GENERATED infra manifest — one node per resource + dependency edges. ' +
    'This code-only scan emits the schema and a best-effort preview, never the generated ' +
    'manifest itself (that requires a live-reconcile pass — see targetArtifacts).',
  node: {
    id: 'string — stable resource identifier (name today; ARN once live-reconciled)',
    type: 'string — resource kind + service, e.g. "database:DynamoDB"',
    arn: 'string|null — NOT resolvable from code alone; populated by a live reconcile pass',
    managed_by: 'the codifying tool name, or UNMANAGED',
    source: 'declared | referenced-only | inferred — provenance of this entry',
    verification_status:
      'declared | verified — declared = code-only claim; verified = confirmed against live state',
    tags: {
      owner: 'string|null',
      cost_center: 'string|null',
      capability: 'string|null',
      data_classification: 'string|null',
    },
    cost_model: 'standing | metered | subscription | connectivity | none',
    pii: 'boolean',
    lifecycle: 'keep | retire',
    depends_on:
      'string[] — edges to other node ids, computed at SERVICE granularity from the ' +
      "alias-resolved file-import graph (which files reference this node's service " +
      "import files that reference another service's) when a code graph was built for " +
      'this scan; [] when it was not (a targeted re-scan without graph enrichment, or ' +
      'a repo with no resolvable internal imports) — never fabricated either way',
  },
  edgeTypes: ['depends_on', 'holds_data_of_class', 'managed_by', 'shares'],
};

/**
 * Item 2/3 preview — reshapes what the scan ALREADY knows (services/resources +
 * external/3rd-party detections) into the manifest's node schema, so the schema above is
 * proven against a real repo, not just documented in the abstract. `depends_on` is
 * populated from `inventory.serviceDependencyEdges` (enrichInfraWithGraph, cross-
 * referencing the alias-resolved file-import graph — see infra-extract.mjs) at SERVICE
 * granularity: a resource-level node inherits its parent service's edge list, since file
 * attribution doesn't resolve to individual tables/buckets. `[]` when no code graph was
 * built for this scan (honest degrade, not a crash).
 */
function buildManifestPreview(inventory, tool, retireSet, meteringArtifacts) {
  const nodes = [];
  const depsOf = (serviceName) => inventory.serviceDependencyEdges?.[serviceName] || [];
  const tagStub = () => ({
    owner: null,
    cost_center: null,
    capability: null,
    data_classification: null,
  });
  for (const s of inventory.services || []) {
    const svcDeclared =
      (s.detectedBy || []).includes('iac-declared') ||
      (s.detectedBy || []).includes('platform-config');
    const svcRetire = retireSet.has(s.name);
    if (s.resources && s.resources.length) {
      for (const r of s.resources) {
        const tags = tagStub();
        if (r.contains_pii) tags.data_classification = 'PII';
        nodes.push({
          id: r.name,
          type: `${s.kind}:${s.name}`,
          arn: null,
          managed_by: r.declared ? tool : 'UNMANAGED',
          source: r.declared ? 'declared' : 'referenced-only',
          verification_status: 'declared',
          tags,
          cost_model: s.costModel || null,
          pii: !!r.contains_pii,
          lifecycle: r.orphanCandidate || svcRetire || retireSet.has(r.name) ? 'retire' : 'keep',
          depends_on: depsOf(s.name),
        });
      }
    } else {
      nodes.push({
        id: s.name,
        type: s.kind,
        arn: null,
        managed_by: svcDeclared ? tool : 'UNMANAGED',
        source: svcDeclared ? 'declared' : 'inferred',
        verification_status: 'declared',
        tags: tagStub(),
        cost_model: s.costModel || null,
        pii: false,
        lifecycle: svcRetire ? 'retire' : 'keep',
        depends_on: depsOf(s.name),
      });
    }
  }
  // 3rd-party services are first-class nodes too, off-cloud + metered — never AWS IaC.
  const externalNames = new Set((inventory.external || []).map((e) => e.provider));
  const hasMetering = !!(meteringArtifacts && meteringArtifacts.length);
  const thirdParty = (inventory.services || [])
    .filter((s) => externalNames.has(s.name))
    .map((s) => ({
      id: s.name,
      type: 'external-service',
      cost_model: s.costModel || null,
      // Never claims WHICH service a found artifact covers — that's a verification call,
      // not something a code-only scan can attribute with confidence.
      metering_source: hasMetering
        ? {
            present: true,
            candidates: meteringArtifacts.map((m) => m.name),
            note: 'not verified to specifically cover this service',
          }
        : {
            present: false,
            candidates: [],
            note: 'no usage/billing/pricing artifact detected in-repo — cost is unattributed',
          },
      env_key: (s.declares || []).find((d) => /^[A-Z][A-Z0-9_]+$/.test(d)) || null,
      dpa_required: true,
      dpa_verified: false, // code cannot confirm a signed DPA exists — always a backlog item
      basis: 'declared',
    }));
  return {
    nodes,
    thirdParty,
    note:
      'PREVIEW derived from code-only detection — not the generated manifest. depends_on ' +
      'edges are SERVICE-granularity (from the alias-resolved file-import graph, when a ' +
      'code graph was built for this scan — [] otherwise). arn resolution and live tag ' +
      'values still require a live-reconcile pass this scan does not perform.',
  };
}

/**
 * Item 1 — the plan's definition of done as a concrete artifact set, stack-aware (never
 * hardcodes a specific tool beyond what was already detected/recommended elsewhere in
 * this plan). `imports` (post-retire-routing) tells us whether a data-plane split is
 * still needed; tagTaxonomy/governance tell us whether the tag module / policy pack exist.
 */
function buildTargetArtifacts(tool, maturity, imports) {
  const mat = maturity || {};
  const govLevel = mat.dimensions?.governance?.level ?? 0;
  const tagPct = mat.tagTaxonomy?.coveragePct ?? 0;
  const dataPlaneNeeded = imports.length > 0;
  // SST's own native substrate is Pulumi — a companion data-plane project for an SST repo
  // is idiomatically Pulumi; every other tool is its own natural companion (a second
  // Terraform/CDK/Pulumi project or workspace, not a tool switch).
  const companionTool = tool === 'sst' ? 'pulumi' : tool;
  return [
    {
      id: 'compute-stack',
      kind: 'compute-stack',
      tool,
      status: 'exists',
      description: `${tool}-managed compute — already codified.`,
    },
    {
      id: 'data-plane-stack',
      kind: 'data-plane-stack',
      tool: companionTool,
      status: dataPlaneNeeded ? 'missing' : 'exists',
      description: dataPlaneNeeded
        ? `A separate ${companionTool} project for the data plane (the still-undeclared stateful resources), imported and referenced by the compute stack via stack outputs — separates the two lifecycles and kills hardcoded resource-name strings in the compute config.`
        : 'No undeclared data-plane resources remain to split out.',
    },
    {
      id: 'tag-module',
      kind: 'tag-module',
      status: tagPct >= 100 ? 'exists' : 'missing',
      description: 'One shared tag-taxonomy module, merged onto every resource across both stacks.',
    },
    {
      id: 'policy-pack',
      kind: 'policy-pack',
      status: govLevel >= 2 ? 'exists' : 'missing',
      description:
        'Policy-as-code pack enforcing the tag taxonomy + encryption + backup posture (advisory → mandatory).',
    },
    {
      id: 'infra-manifest',
      kind: 'infra-manifest',
      status: 'missing',
      description:
        'ONE generated, machine-readable manifest (see manifestSchema) — the canonical source FinOps/privacy/policy consume. Not yet built by this scan — see manifestPreview for what it will look like, and finopsReadiness for why it currently blocks.',
    },
  ];
}

/**
 * Item 4 — resolve the import-substrate fork EXPLICITLY when the repo's own code says a
 * resource is intentionally kept out of the primary tool (SCOPE-BOUNDARY-style signal).
 * Presenting a single opinionated "adopt in <tool>" command in that situation contradicts
 * the repo's own documented intent and risks state divergence — so instead the plan
 * presents the decision, tool-agnostically, with trade-offs. Absent the signal (the common
 * case), the caller keeps its existing single-recommendation behavior unchanged.
 */
function buildImportDecision(tool, inventory) {
  const sep = inventory.intentionalSeparation;
  if (!sep || !sep.present) return null;
  const companionTool = tool === 'sst' ? 'pulumi' : tool;
  return {
    context: `The repo documents that these resources are deliberately kept OUTSIDE ${tool} (${sep.evidence}) — declaring them directly in ${tool}'s config risks state divergence with whatever already manages them. This is a decision to make explicitly, not a default to apply silently.`,
    recommended: 'separate-project',
    options: [
      {
        id: 'separate-project',
        label: `Separate ${companionTool} project for the data plane, imported and referenced by ${tool} via stack outputs`,
        recommended: true,
        tradeoffs: `Clean separation of lifecycles (compute vs data), no state-divergence risk, matches the repo's own documented intent. Adds a second state backend to operate.`,
      },
      {
        id: 'fold-in',
        label: `Fold the data plane directly into ${tool}'s existing config`,
        recommended: false,
        tradeoffs: `Single state backend, simpler day-1 ops — but contradicts the repo's own separation note, and risks ${tool} recreating or conflicting with resources another process manages.`,
      },
    ],
  };
}

/**
 * Item 6 — FinOps readiness as a TESTABLE definition of done, not a vibe. `ready` flips
 * true only when every condition is objectively met; until then `blockedBy` lists the
 * exact unmet conditions so "start FinOps" has a mechanical green light. The manifest
 * condition is an HONEST permanent blocker today — this scan emits a schema + preview,
 * never the generated/reconciled manifest FinOps actually needs (see targetArtifacts).
 */
function buildFinopsReadiness(inventory, imports, meteringArtifacts) {
  const mat = inventory.iacMaturity || {};
  const tax = mat.tagTaxonomy || {};
  const blockedBy = [];
  if (imports.length)
    blockedBy.push(
      `${imports.length} live resource(s) still undeclared/unimported: ${imports
        .slice(0, 4)
        .map((i) => i.resource)
        .join(', ')}${imports.length > 4 ? '…' : ''}`,
    );
  const tagPct = tax.coveragePct ?? 0;
  if (tagPct < 100)
    blockedBy.push(
      `tag taxonomy incomplete (${tagPct}%; missing: ${(tax.missing || []).join(', ') || 'tags'})`,
    );
  blockedBy.push(
    'infra manifest not yet generated — this scan emits the schema + a code-derived preview only; FinOps needs the generated, live-reconciled manifest (see targetArtifacts)',
  );
  const externalCount = (inventory.external || []).length;
  if (externalCount > 0 && !(meteringArtifacts && meteringArtifacts.length))
    blockedBy.push(
      `${externalCount} external/metered service(s) have no detected metering-source pointer (no usage/billing/pricing artifact found in-repo)`,
    );
  return { ready: blockedBy.length === 0, basis: 'declared', blockedBy };
}

// Deprecated-toolchain severity → migration phase. EOL/archived tooling is urgent
// (Phase 0 stop-the-bleeding); low-severity maintenance-mode swaps are Phase 8.
const DEP_PHASE = { high: 0, medium: 0, low: 8 };

function deprecatedSteps(maturity, tool) {
  const out = [];
  for (const d of maturity.deprecated || []) {
    if (!d || !d.tool) continue;
    const sev = String(d.severity || 'low').toLowerCase();
    const phase = DEP_PHASE[sev] != null ? DEP_PHASE[sev] : 8;
    const action = d.remediation || `Replace ${d.tool} with a maintained tool.`;
    out.push({
      phase,
      title: `Replace deprecated toolchain: ${d.tool}`,
      dimension: 'deprecated',
      why: `${d.tool} is ${d.status || 'deprecated'}${d.eolDate ? ` (EOL ${d.eolDate})` : ''} — migrate off it before it breaks the pipeline.`,
      tool,
      commands: [`# ${action}`],
      goldenRule: GOLDEN[tool] || GOLDEN.terraform,
    });
  }
  return out;
}

/**
 * Build the gap-driven, stack-aware IaC migration track from an infra inventory.
 *
 * @param {object} inventory — output of buildInfraInventory (+ enrichInfraWithGraph),
 *   carrying `iacMaturity`, `iacCoverage`, `deployScripts`, `services[].fanIn`.
 * @param {{ stack?: object|null, gitEvolution?: object|null }} [opts]
 *   - stack: the Stack Profile ({profile} wrapper or the profile itself) — tool hint.
 *   - gitEvolution: the Git & Evolution report — supplies churn for import priority.
 * @returns {null | {
 *   currentLevel:number, targetLevel:number, levelName:string,
 *   nextThree:Array<{title:string,dimension:string,action:string}>,
 *   track:Array<{phase:number,title:string,dimension:string,why:string,tool:string,
 *                commands:string[],imports?:Array<{resource,source,priority}>,
 *                unlocks?:string[],goldenRule:string}>,
 * }}
 */
export function planIacTrack(inventory, { stack = null, gitEvolution = null } = {}) {
  const maturity = inventory && inventory.iacMaturity;
  // Guard: a targeted/deterministic re-scan may reuse a prior infra inventory that
  // predates iacMaturity. No grade → no plan (runner tolerates a null iacPlan).
  if (!maturity || typeof maturity !== 'object') return null;

  const stackProfile = (stack && stack.profile) || stack || null;
  const tool = detectStackTool(inventory, stackProfile);
  const toolCmds = TOOLING[tool] || TOOLING.terraform;
  const goldenRule = GOLDEN[tool] || GOLDEN.terraform;

  const currentLevel = typeof maturity.level === 'number' ? maturity.level : 0;
  const targetLevel = Math.min(currentLevel + 1, 4);
  const dims = maturity.dimensions || {};

  // A dimension is SATISFIED (→ omit its step) when it already meets the target level
  // AND carries no remaining gaps. Unknown dimensions are treated as needing work.
  const satisfied = (dim) => {
    const d = dims[dim];
    if (!d) return false;
    const level = typeof d.level === 'number' ? d.level : 0;
    const gaps = Array.isArray(d.gaps) ? d.gaps : [];
    return level >= targetLevel && gaps.length === 0;
  };

  const { imports, retire } = buildImports(inventory, gitEvolution);

  const gapSteps = [];
  for (const spec of DIMENSION_SPECS) {
    if (satisfied(spec.dim)) continue; // gap-driven: skip dimensions already at target
    const commands = spec.keys.flatMap((k) => toolCmds[k] || []);
    const step = {
      phase: spec.phase,
      title: spec.title,
      dimension: spec.dim,
      why: spec.why,
      tool,
      commands,
      // The golden rule ("plan/preview must show no changes") only applies to steps that
      // MUTATE live infra (state/import, env-sep, modularity). Adding CI tests, a policy
      // pack, or a scheduled drift check changes no live state — attaching it there is the
      // copy-pasted-boilerplate the report agent flagged. Gate it on the spec's own flag.
      ...(spec.mutating ? { goldenRule } : {}),
    };
    if (spec.seedImports && imports.length) step.imports = imports;
    gapSteps.push(step);
  }

  // P3 — "Adopt unmanaged resources into IaC": gated on iacCoverage TRUTH (the
  // undeclared[] service list, or — once P2 resource-level fields land — a
  // resourceRatio < 1), INDEPENDENT of the 'state' dimension's satisfied() check. A
  // repo can have remote, locked state (state dimension already at target, no gaps)
  // while individual resources remain undeclared or only IAM-referenced — those must
  // still surface as an adoption action, or every later step (testing, drift/cost,
  // governance) silently excludes them. Degrades gracefully when resourceRatio is
  // absent (older inventories, pre-P2): falls back to the undeclared[] check alone.
  const coverage = inventory.iacCoverage || {};
  const hasUndeclared = Array.isArray(coverage.undeclared) && coverage.undeclared.length > 0;
  const ratioIncomplete = typeof coverage.resourceRatio === 'number' && coverage.resourceRatio < 1;
  if (hasUndeclared || ratioIncomplete) {
    // Pre-import data-protection gate: importing a live resource can DESTROY it if a
    // mis-authored import recreates it — so enable backups/versioning/deletion-protection
    // FIRST. Derived from which store KINDS are present (never a hardcoded resource), and
    // only for stores we are actually going to adopt (orphan/retiring stores excluded).
    const liveStores = (inventory.services || []).filter((s) => s.dataStore && !s.orphanCandidate);
    const preflight = [];
    if (liveStores.some((s) => s.kind === 'database'))
      preflight.push(
        'Enable point-in-time recovery + deletion protection on every live data-store table BEFORE import — a mis-authored adopt can destroy unprotected data (see the verification backlog).',
      );
    if (liveStores.some((s) => s.kind === 'storage'))
      preflight.push('Enable versioning on every live object-store bucket BEFORE import.');

    const adoptionStep = {
      phase: 1, // between deprecated-toolchain (0, stop-the-bleeding) and state (2)
      title: 'Adopt unmanaged resources into IaC',
      dimension: 'adoption',
      why: 'Resources are running but not declared in any IaC file (or only referenced via IAM ARNs) — adopt them before other migration work, or state/testing/governance steps will silently exclude them.',
      tool,
      commands: toolCmds.state || [],
      unlocks: ['finops', 'privacy', 'policy-as-code'],
      goldenRule,
    };
    if (preflight.length) adoptionStep.preflight = preflight;
    if (imports.length) adoptionStep.imports = imports;
    // Keep/retire classifier: resources with a code-readable retirement signal are listed
    // as "retire, do NOT adopt" on the same step, so the plan never tells you to codify
    // infra you're deleting (the biggest logic gap the report agent found).
    if (retire.length) adoptionStep.retire = retire;
    // Item 5 — safe teardown order for whatever's in retire[].
    const retireSequence = buildRetireSequence(retire);
    if (retireSequence) adoptionStep.retireSequence = retireSequence;
    // Item 4 — when the repo's own code says these resources are deliberately kept
    // separate, present the fork instead of one opinionated command. The commands list
    // narrows to just the golden-rule verification line (present across every TOOLING
    // profile) — the opinionated "adopt in <tool>" line only fires without the signal.
    const importDecision = buildImportDecision(tool, inventory);
    if (importDecision) {
      adoptionStep.importDecision = importDecision;
      adoptionStep.commands = (toolCmds.state || []).filter((c) => /MUST show/i.test(c));
    }
    gapSteps.push(adoptionStep);
  }

  // Merge deprecated-toolchain remediations, then order the whole track foundations-
  // first (by phase). Stable within a phase preserves the DIMENSION_SPECS ordering.
  // `phase` is the canonical iac-migration.md anchor (state=2, envSep/modularity=3, …) —
  // it drives foundations-first ordering but is NOT a display ordinal: when a phase is
  // satisfied-and-skipped (no Phase 2) or two dims share a playbook phase (envSep +
  // modularity both = 3), rendering it raw shows gaps and duplicates ("Phase 1, 3, 3…").
  // `seq` is the 1-based position in the emitted track — the number the UI shows.
  const track = [...deprecatedSteps(maturity, tool), ...gapSteps]
    .map((s, i) => ({ ...s, _i: i }))
    .sort((a, b) => a.phase - b.phase || a._i - b._i)
    .map(({ _i, ...s }, i) => ({ ...s, seq: i + 1 }));

  // "Level N → N+1: next 3 actions" — the highest-leverage steps (foundations first).
  const nextThree = track.slice(0, 3).map((s) => ({
    title: s.title,
    dimension: s.dimension,
    action: (s.commands && s.commands[0]) || s.why,
  }));

  // Items 1–3, 6 — the plan's target state: a concrete artifact set + the manifest
  // standard (schema + a code-derived preview proving it against this repo) + a testable
  // FinOps definition-of-done. `retireSet` also feeds the manifest preview's lifecycle
  // field so a retiring resource never reads "keep" there either.
  const retireSet = new Set(retire.map((r) => r.resource));
  const meteringArtifacts = inventory.meteringArtifacts || [];
  const targetArtifacts = buildTargetArtifacts(tool, maturity, imports);
  const manifestPreview = buildManifestPreview(inventory, tool, retireSet, meteringArtifacts);
  const finopsReadiness = buildFinopsReadiness(inventory, imports, meteringArtifacts);

  return {
    currentLevel,
    targetLevel,
    levelName: LEVEL_NAMES[targetLevel] || LEVEL_NAMES[LEVEL_NAMES.length - 1],
    nextThree,
    track,
    targetArtifacts,
    manifestSchema: MANIFEST_SCHEMA,
    manifestPreview,
    finopsReadiness,
    // Keep/retire classifier output, hoisted for consumers that don't walk the track.
    ...(retire.length ? { retire } : {}),
  };
}
