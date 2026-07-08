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
  const addRetire = (resource, reason, source) => {
    if (!resource || seenRetire.has(resource)) return;
    seenRetire.add(resource);
    retire.push({ resource, reason, source: source || null });
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

  return {
    currentLevel,
    targetLevel,
    levelName: LEVEL_NAMES[targetLevel] || LEVEL_NAMES[LEVEL_NAMES.length - 1],
    nextThree,
    track,
    // Keep/retire classifier output, hoisted for consumers that don't walk the track.
    ...(retire.length ? { retire } : {}),
  };
}
