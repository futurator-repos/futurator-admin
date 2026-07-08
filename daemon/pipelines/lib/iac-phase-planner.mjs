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
  'gcp-im': '`terraform plan` (Infrastructure Manager preview) must show "No changes" before you commit.',
};

const TOOLING = {
  pulumi: {
    state: [
      'pulumi login s3://<state-bucket>   # managed/remote backend (or Pulumi Cloud)',
      'pulumi import --file resources.json   # bulk-adopt existing resources ({type,name,id}[])',
      'pulumi preview   # MUST show no changes; imported resources are `protect`-ed by default',
    ],
    envSeparation: ['pulumi stack init dev && pulumi stack init staging && pulumi stack init prod   # per-env stacks + Pulumi.<stack>.yaml'],
    modularity: ['# extract shared infra into ComponentResource classes / a shared @org/infra package'],
    testing: ['# Pulumi unit tests: pulumi.runtime.setMocks(...) + jest/mocha; wire as a required CI check'],
    governance: ['pulumi policy new <pack> --language typescript   # CrossGuard: require tags, pin region, deny public buckets (advisory → mandatory)'],
    driftCost: ['pulumi preview --expect-no-changes   # schedule via GitHub Actions cron (drift detection)'],
    cost: ['# add Infracost PR diff comments to the CI plan step'],
  },
  terraform: {
    state: [
      '# backend.tf: terraform { backend "s3" { bucket = ...; dynamodb_table = ... } }   # remote + locked state',
      '# add import {} blocks, then: terraform plan -generate-config-out=generated.tf',
      'terraform apply && terraform plan   # MUST show "No changes"; then delete the import blocks',
      '# NOTE: Terraformer is a one-shot bulk export only (archived Mar 16 2026) — NEVER a pipeline step',
    ],
    envSeparation: ['# split state per env: environments/{dev,staging,prod}/ (or terraform workspace) with per-env *.tfvars'],
    modularity: ['# extract modules/ with PINNED sources (version = / ?ref=); replace the root-monolith resources'],
    testing: ['# native tests: *.tftest.hcl (terraform test) + terraform fmt/validate as required CI checks'],
    governance: ['checkov -d . --compact   # + `trivy config .`; start advisory, promote to mandatory'],
    driftCost: ['# scheduled `terraform plan` in CI (drift detection — the infra analogue of spec-drift)'],
    cost: ['# Infracost PR diff (infracost.yml) gating cost on PR'],
  },
  opentofu: {
    state: [
      '# backend.tf: terraform { backend "s3" { bucket = ...; use_lockfile = true } }   # remote + locked state',
      '# add import {} blocks, then: tofu plan -generate-config-out=generated.tf',
      'tofu apply && tofu plan   # MUST show "No changes"; then delete the import blocks',
      '# NOTE: Terraformer is a one-shot bulk export only (archived Mar 16 2026) — NEVER a pipeline step',
    ],
    envSeparation: ['# split state per env: environments/{dev,staging,prod}/ (or tofu workspace) with per-env *.tfvars'],
    modularity: ['# extract modules/ with PINNED sources (version = / ?ref=); replace the root-monolith resources'],
    testing: ['# native tests: *.tftest.hcl (tofu test) + tofu fmt/validate as required CI checks'],
    governance: ['checkov -d . --compact   # + `trivy config .`; start advisory, promote to mandatory'],
    driftCost: ['# scheduled `tofu plan` in CI (drift detection)'],
    cost: ['# Infracost PR diff (infracost.yml) gating cost on PR'],
  },
  cdk: {
    state: [
      'cdk migrate --stack-name <name> --from-scan new   # generate a CDK app from deployed resources',
      '# or wrap existing CFN with CfnInclude; adopt one-off resources with: cdk import',
      'cdk diff   # MUST show no changes; WARN: check RemovalPolicy defaults so stateful resources are not destroyed',
    ],
    envSeparation: ['# separate stacks per env via Stage constructs / cdk.context (dev/staging/prod)'],
    modularity: ['# extract reusable L3 Constructs / a constructs library'],
    testing: ['# CDK assertions (aws-cdk-lib/assertions) + snapshot tests wired into CI'],
    governance: ['checkov -d cdk.out --compact   # scan synthesized templates; + org policy (advisory → mandatory)'],
    driftCost: ['# scheduled `cdk diff` in CI (drift detection)'],
    cost: ['# Infracost on the synthesized CloudFormation'],
  },
  sst: {
    state: [
      '# SST manages remote state via its own backend — no manual state bootstrap needed',
      '# adopt existing resources in sst.config.ts (SST v3 is Pulumi-based): use { transform } / the import option',
      'sst diff   # MUST show no changes before you deploy',
    ],
    envSeparation: ['sst deploy --stage dev|staging|production   # per-stage isolation is built in'],
    modularity: ['# extract infra into infra/*.ts modules imported by sst.config.ts'],
    testing: ['# unit-test infra modules (vitest) + `sst diff` as a required CI check'],
    governance: ['# add a Pulumi CrossGuard pack (SST v3 runs on Pulumi) / checkov on synthesized templates'],
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
    dim: 'state', phase: 2, title: 'Remote state & resource import', keys: ['state'],
    mutating: true, seedImports: true,
    why: 'Get every running resource into remote, locked, version-controlled state — the Level 1→2 boundary everything else builds on.',
  },
  {
    dim: 'envSeparation', phase: 3, title: 'Environment separation', keys: ['envSeparation'],
    mutating: true,
    why: 'Isolate dev/staging/prod state so a change to one environment can never clobber another.',
  },
  {
    dim: 'modularity', phase: 3, title: 'Refactor to reusable modules', keys: ['modularity'],
    mutating: true,
    why: 'Generated/monolithic infra is a starting point — extract DRY, pinned modules so it stays maintainable.',
  },
  {
    dim: 'testing', phase: 4, title: 'IaC testing', keys: ['testing'],
    mutating: false,
    why: 'Static validation + unit tests as required CI checks — the infrastructure TDD layer.',
  },
  {
    dim: 'driftCost', phase: 5, title: 'Drift detection & cost gate', keys: ['driftCost', 'cost'],
    mutating: false,
    why: 'A scheduled plan/preview is the infra analogue of a spec-conformance check; Infracost gates cost on PR.',
  },
  {
    dim: 'governance', phase: 6, title: 'Policy-as-code guardrails', keys: ['governance'],
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
  if (gitEvolution.churnByFile && typeof gitEvolution.churnByFile[file] === 'number') return gitEvolution.churnByFile[file];
  if (Array.isArray(gitEvolution.hotFiles)) {
    const h = gitEvolution.hotFiles.find((x) => x && x.file === file);
    if (h && typeof h.churn === 'number') return h.churn;
  }
  return 0;
}

/**
 * Seed the import list from what the scan already detects: every undeclared
 * provisionable service + every hand-rolled deploy script. priority = fanIn × churn
 * (multiplier is 1 when no git history is available, so ordering degrades to fanIn).
 * Sorted DESC by priority, ties broken by resource name for determinism.
 */
function buildImports(inventory, gitEvolution) {
  const hasGit = !!(gitEvolution && (gitEvolution.churnByFile || gitEvolution.hotFiles));
  const servicesByName = new Map((inventory.services || []).map((s) => [s.name, s]));
  const iacCoverage = inventory.iacCoverage || {};
  const out = [];

  for (const name of iacCoverage.undeclared || []) {
    const svc = servicesByName.get(name);
    const fanIn = svc && typeof svc.fanIn === 'number' ? svc.fanIn : 1;
    const files = svc && Array.isArray(svc.files) ? svc.files : [];
    const churn = files.reduce((acc, f) => acc + churnOf(gitEvolution, f), 0);
    const priority = fanIn * (hasGit ? churn : 1);
    out.push({
      resource: name,
      source: files[0] || 'inferred-from-usage (declared in no IaC file)',
      priority,
    });
  }

  for (const ds of inventory.deployScripts || []) {
    const churn = churnOf(gitEvolution, ds.file);
    // deploy scripts are not services; borrow fan-in from the heaviest resource they
    // provision (a script deploying a high-fan-in Lambda should import first).
    let fanIn = 1;
    for (const p of ds.provisions || []) {
      const svc = servicesByName.get(p);
      if (svc && typeof svc.fanIn === 'number' && svc.fanIn > fanIn) fanIn = svc.fanIn;
    }
    const priority = fanIn * (hasGit ? churn : 1);
    const resource = ds.provisions && ds.provisions.length ? ds.provisions.join(', ') : ds.kind || 'resources';
    out.push({ resource, source: ds.file, priority });
  }

  return out.sort((a, b) => b.priority - a.priority || String(a.resource).localeCompare(String(b.resource)));
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

  const imports = buildImports(inventory, gitEvolution);

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
      goldenRule,
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
    if (imports.length) adoptionStep.imports = imports;
    gapSteps.push(adoptionStep);
  }

  // Merge deprecated-toolchain remediations, then order the whole track foundations-
  // first (by phase). Stable within a phase preserves the DIMENSION_SPECS ordering.
  const track = [...deprecatedSteps(maturity, tool), ...gapSteps]
    .map((s, i) => ({ ...s, _i: i }))
    .sort((a, b) => a.phase - b.phase || a._i - b._i)
    .map(({ _i, ...s }) => s);

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
  };
}
