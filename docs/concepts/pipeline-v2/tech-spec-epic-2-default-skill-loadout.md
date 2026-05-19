# Tech Spec — Epic 2: Default skill loadout per starter

> **Parent plan:** `plan-skills-activation.md` §4
> **Goal:** ship the first measurable signal of skills affecting agent
> behavior. Bypasses SKILL-SCOUT entirely — hardcode 2–4 skills per
> starter, vendor them at app-bootstrap time, let Claude Code's
> auto-discovery do the rest.
> **Effort:** ~3 dev-days end-to-end (2.0 + 2.1 + 2.2 + 2.3 + 2.4).
> **Critical-path blocker for:** Epics 4 (`loadedSkills[]` tracking),
> 5 (CLAUDE.md write hooks), 6 (REFLECTOR), 7 (observability).
> **Dependencies:** Epic 1.1 (`futurator-skills` repo) only blocks if we
> pin skills from that source. With the v1 loadout below (all
> `anthropic-official`), Epic 2 can ship **independently of Epic 1**.

---

## 0. The foundational assumption — Story 2.0 (pre-flight, 30 min)

> **STATUS — 2026-05-19: ✅ GREEN. Probe artifacts at
> `docs/concepts/logs/skills-probe-2026-05-19/`. No pivot needed; Stories
> 2.1–2.3 ship as designed.**
>
> Summary of findings:
>
> - `claude -p` (CLI 2.1.144) auto-discovers `.claude/skills/<name>/SKILL.md`
>   in cwd. The skill appears in both the `slash_commands` and `skills` arrays
>   of the stream-json init event.
> - The model **autonomously invokes** the skill via Claude Code's built-in
>   `Skill` tool (`{"name":"Skill","input":{"skill":"canvas-design"}}`) when
>   the prompt content matches the skill's frontmatter `description`. No
>   `/skill-name` slash command, no `--append-system-prompt`, no CLI flag.
> - Works without `--setting-sources project` — matches how the daemon's
>   `runAgent()` invokes `claude -p` in production.
> - **Bonus signal for Epic 4:** count `tool_use` events with `name: "Skill"`
>   per agent invocation. Forensic record of which skills actually got used
>   per story falls out for free.

**Risk (now closed):** the entire epic relies on Claude Code auto-discovering
`.claude/skills/*/SKILL.md` files in the agent's `cwd` at `claude -p`
startup. If non-interactive `claude -p` doesn't auto-load skills the way
interactive Claude Code does, **Epic 2's value disappears** and we'd have
to inject SKILL.md bodies manually via `--append-system-prompt`.

### 2.0 Acceptance: prove auto-discovery works in non-interactive mode

Run this script on a clean directory before writing any other code:

```bash
mkdir -p /tmp/skills-probe && cd /tmp/skills-probe
git init -q
mkdir -p .claude/skills/canvas-design
curl -sSL https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/SKILL.md \
  -o .claude/skills/canvas-design/SKILL.md

# Probe 1: does claude -p surface it under a direct question?
claude -p "What skills do you have available in this directory? List them by name." \
  --output-format stream-json --verbose 2>&1 | tee probe1.ndjson

# Probe 2: does claude -p USE the skill on an obvious match?
claude -p "I need to draw a 16x16 pixel-art sprite of a snake head on HTML canvas. \
  Walk me through the canvas-design skill's approach." \
  --output-format stream-json --verbose 2>&1 | tee probe2.ndjson
```

**Pass criteria** (any one of these → green light to proceed):

1. Probe 1's response names `canvas-design` (proves auto-discovery).
2. Probe 2's response references concepts from `canvas-design/SKILL.md`
   that aren't in the prompt (proves activation on relevance).
3. The stream-json shows a `system-skill-loaded` or equivalent metadata
   event referencing `canvas-design`.

**Fail handling.** If both probes are negative, pivot Epic 2:

- Keep stories 2.1 + 2.3 (vendoring) — they're prerequisites for any approach.
- Replace story 2.2 with **2.2-fallback**: daemon injects SKILL.md content
  per agent role via `--append-system-prompt` in `runAgent()`. Role
  policy in `role-policy.mjs` declares which skills each role gets
  (e.g. DEV gets all 3 for `nextjs-canvas-game`; REVIEWER gets only
  `frontend-design`).
- Effort delta: +½ day (still bounded; the helper is ~30 lines).

Either way, **2.0 is the first hour of work on this epic and gates
everything else.**

---

## 1. Story 2.1 — Populate `defaultSkillLoadout` per starter

**Effort:** ½ day · **Files touched:** 1

### What

Add the `defaultSkillLoadout` field (already declared in
`functions/shared/boilerplates/types.ts:57` but currently always
`undefined`) to each wired starter pack in
`functions/shared/boilerplates/registry.ts`.

### Why

Today the field exists in the type but no boilerplate populates it.
We're hardcoding the v1 mapping rather than relying on SKILL-SCOUT
because SKILL-SCOUT wire-in is Epic 3 — which is itself blocked on
having vendored skills first to validate the install path.

### Mapping (v1)

| Starter                 | Skills                                                | Rationale                                                    |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `nextjs-base`           | `frontend-design`, `webapp-testing`                   | Universal Next.js best practices + test idioms               |
| `nextjs-canvas-game`    | `canvas-design`, `frontend-design`, `algorithmic-art` | Canvas 2D + UI + procedural art (snake, dino, brick-breaker) |
| `nextjs-form-app`       | `frontend-design`, `webapp-testing`                   | Form UI conventions + testing                                |
| `nextjs-dashboard`      | `frontend-design`                                     | Dashboard layout patterns                                    |
| `sst`, `vite`, `mobile` | `null` (skip step — stub boilerplates)                | No test infrastructure shipped yet                           |

All from `anthropic-official` source. Format: `<skill>@<source>` strings
matching the federation source IDs in
`daemon/lib/federation-loader.mjs::EMBEDDED_DEFAULT_FEDERATION`.

### Code shape

```ts
// functions/shared/boilerplates/registry.ts (insert near NEXTJS_BASE_PACK)

const NEXTJS_BASE_DEFAULT_SKILLS = [
  'frontend-design@anthropic-official',
  'webapp-testing@anthropic-official',
];

const NEXTJS_BASE_PACK: BoilerplateMetadata = {
  // ...existing fields...
  defaultSkillLoadout: NEXTJS_BASE_DEFAULT_SKILLS,
};

// In createStarterPack() overrides for each wired starter:
'nextjs-canvas-game': createStarterPack({
  type: 'nextjs-canvas-game',
  // ...
  defaultSkillLoadout: [
    'canvas-design@anthropic-official',
    'frontend-design@anthropic-official',
    'algorithmic-art@anthropic-official',
  ],
}),
```

### Tests

Add to `functions/shared/boilerplates/__tests__/registry.test.ts`:

```ts
describe('defaultSkillLoadout', () => {
  it('nextjs-canvas-game ships 3 anthropic-official skills', () => {
    const pack = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(pack.defaultSkillLoadout).toEqual([
      'canvas-design@anthropic-official',
      'frontend-design@anthropic-official',
      'algorithmic-art@anthropic-official',
    ]);
  });

  it('stub boilerplates declare null loadout', () => {
    for (const type of ['sst', 'vite', 'mobile'] as const) {
      expect(BOILERPLATE_REGISTRY[type].defaultSkillLoadout).toBeNull();
    }
  });

  it('every wired starter has at least one core skill', () => {
    const wired = Object.values(BOILERPLATE_REGISTRY).filter(
      (p) => p.status === 'wired' && p.type.startsWith('nextjs'),
    );
    for (const pack of wired) {
      expect(pack.defaultSkillLoadout?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
```

### Validation

- `npm run typecheck` clean
- `npm run test -- registry` green
- No daemon changes needed; this is pure-data registry edit

---

## 2. Story 2.2 — `prepin-default-skills.mjs` bootstrap step

**Effort:** ½ day · **Files touched:** 3 (1 new module, 1 type, 1 caller)

### What

New step that reads the starter's `defaultSkillLoadout` and rewrites
`.claude/skills.manifest.yaml` (created by `apply-starter-augments` per
PR-71 with empty `core: []` etc.) to pre-pin those skills under `core[]`
before `skills-sync.mjs` runs.

### Why

Without this, every new app's manifest stays at the empty PR-71 scaffold
forever. SKILL-SCOUT would fix this in Epic 3, but Epic 2's point is to
ship value without waiting for that.

### Where it slots

Between `apply-starter-augments` (creates the empty manifest) and
`npm-install` (so the `yaml` parsing dep isn't required yet — we'll do
the YAML rewrite ourselves with the daemon's already-installed `yaml`
package):

```
bare-clone
  └─ materialize-worktree
       └─ inject-values
            └─ apply-starter-augments           ← creates empty manifest
                 └─ prepin-default-skills      ← NEW (this story)
                      └─ npm-install
                           └─ vendor-skills    ← NEW (story 2.3)
                                └─ bmad-bootstrap
                                     └─ commit-and-push
```

### Code shape

```js
// daemon/lib/app-bootstrap-steps/prepin-default-skills.mjs (NEW)

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

/**
 * Pre-pin the starter's defaultSkillLoadout into .claude/skills.manifest.yaml.
 *
 * Idempotent: if the manifest already has skills in core[], stack[], etc.,
 * this is a no-op (we don't overwrite SKILL-SCOUT decisions on re-bootstrap).
 *
 * @param {{
 *   worktreeDir: string,
 *   defaultSkillLoadout: string[] | null | undefined,
 *   onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
 * }} args
 * @returns {Promise<{ skipped: boolean, reason?: string, pinnedCount: number, pinned: Array<{skill: string, source: string}> }>}
 */
export async function runPrepinDefaultSkills({ worktreeDir, defaultSkillLoadout, onOutput }) {
  // Stub boilerplates (sst/vite/mobile) declare null → skip.
  if (!defaultSkillLoadout || defaultSkillLoadout.length === 0) {
    return { skipped: true, reason: 'no-default-loadout', pinnedCount: 0, pinned: [] };
  }

  const manifestPath = join(worktreeDir, '.claude/skills.manifest.yaml');
  if (!existsSync(manifestPath)) {
    return { skipped: true, reason: 'manifest-missing', pinnedCount: 0, pinned: [] };
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  let manifest;
  try {
    manifest = parseYaml(raw);
  } catch (e) {
    throw new Error(`prepin: manifest parse failed: ${e.message}`);
  }

  // Idempotency: if SKILL-SCOUT or a prior bootstrap pinned anything, leave alone.
  const existingTotal =
    (manifest.core?.length ?? 0) +
    (manifest.stack?.length ?? 0) +
    (manifest.domain?.length ?? 0) +
    (manifest.vendor?.length ?? 0);
  if (existingTotal > 0) {
    return { skipped: true, reason: 'manifest-non-empty', pinnedCount: 0, pinned: [] };
  }

  // Parse "skill@source" tokens.
  const pinned = defaultSkillLoadout.map((token) => {
    const [skill, source] = token.split('@');
    if (!skill || !source) {
      throw new Error(`prepin: invalid loadout token "${token}" (expected "skill@source")`);
    }
    return { skill, source };
  });

  // Pin into core[]. Stack/domain/vendor stay empty — SKILL-SCOUT proposes those.
  // Version pin: omitted at prepin time; skills-sync.mjs resolves to HEAD on first sync.
  // SKILL-SCOUT T8 weekly refresh will later upgrade to specific SHA pins.
  manifest.core = pinned.map(({ skill, source }) => ({
    source,
    skill,
    version: 'sha:HEAD', // resolved at sync time
  }));

  manifest['generated-by'] = 'prepin-default-skills@v1';

  writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');
  onOutput?.('stdout', `prepin-default-skills: pinned ${pinned.length} skill(s) to core[]\n`);

  return { skipped: false, pinnedCount: pinned.length, pinned };
}
```

### Wire-in

```ts
// functions/shared/boilerplates/types.ts:9 — extend the literal union
export interface PostCreateStep {
  id:
    | 'inject-app-values'
    | 'prepin-default-skills' // NEW
    | 'vendor-skills' // NEW (story 2.3)
    | 'npm-install'
    | 'bmad-bootstrap'
    | 'commit-and-push';
  targetFiles?: string[];
}
```

```js
// daemon/pipelines/app-bootstrap.mjs

import { runPrepinDefaultSkills } from '../lib/app-bootstrap-steps/prepin-default-skills.mjs';

// In stepFns registry (around line 159):
const stepFns = {
  // ...existing entries...
  prepinDefaultSkills: steps.prepinDefaultSkills ?? runPrepinDefaultSkills,
  vendorSkills: steps.vendorSkills ?? runVendorSkills,
};

// Insert call after apply-starter-augments (around line 249), before npm-install:
await emitStarted('prepin-default-skills');
const prepinResult = await stepFns.prepinDefaultSkills({
  worktreeDir,
  defaultSkillLoadout: view.defaultSkillLoadout,
  onOutput: makeOutputSink('prepin-default-skills'),
});
await emitCompleted('prepin-default-skills', {
  skipped: !!prepinResult.skipped,
  reason: prepinResult.reason,
  pinnedCount: prepinResult.pinnedCount,
});
```

### `BOILERPLATE_VIEW` augment

`view.defaultSkillLoadout` doesn't exist yet on `BOILERPLATE_VIEW`. Add
it to the local `NEXTJS_VIEW` const in `app-bootstrap.mjs:59`:

```js
const NEXTJS_VIEW = {
  runtime: 'node',
  bmadSupported: true,
  isStub: false,
  defaultSkillLoadout: undefined, // overridden per starter via job.appBootstrapPayload
  // ...existing fields
};
```

And thread it through from the API Lambda's bootstrap payload —
`functions/shared/boilerplates/registry.ts` already exports the field,
the API just needs to include it in `appBootstrapPayload`. Add to
`pipeline-launcher.ts` (or wherever the payload is built) — search for
`augmentFiles:` and add `defaultSkillLoadout: pack.defaultSkillLoadout`
alongside.

### Tests

```js
// daemon/lib/app-bootstrap-steps/__tests__/prepin-default-skills.test.mjs (NEW)

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPrepinDefaultSkills } from '../prepin-default-skills.mjs';

describe('prepin-default-skills', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prepin-'));
  });

  it('pins core skills into empty manifest', async () => {
    writeManifest(
      dir,
      'project: foo\nmanifest-version: 1\ncore: []\nstack: []\ndomain: []\nvendor: []\nplans: {}\ngaps: []\n',
    );
    const r = await runPrepinDefaultSkills({
      worktreeDir: dir,
      defaultSkillLoadout: [
        'canvas-design@anthropic-official',
        'frontend-design@anthropic-official',
      ],
    });
    expect(r.skipped).toBe(false);
    expect(r.pinnedCount).toBe(2);
    const out = readFileSync(join(dir, '.claude/skills.manifest.yaml'), 'utf-8');
    expect(out).toMatch(/skill: canvas-design/);
    expect(out).toMatch(/source: anthropic-official/);
  });

  it('is idempotent — skips when manifest already has skills', async () => {
    /* ... */
  });
  it('skips when defaultSkillLoadout is null', async () => {
    /* ... */
  });
  it('rejects malformed token', async () => {
    /* ... */
  });
  it('skips when manifest file missing', async () => {
    /* ... */
  });
});
```

---

## 3. Story 2.3 — `vendor-skills.mjs` bootstrap step

**Effort:** 1 day · **Files touched:** 2 (1 new module, 1 caller edit)

### What

Run `node scripts/skills-sync.mjs` in the worktree. The script already
exists (shipped via PR-71 augment, lives at `<workingDir>/scripts/skills-sync.mjs`)
and is fully tested standalone — we just need a daemon step that invokes
it.

### Why

`skills-sync.mjs` reads `.claude/skills.manifest.yaml` (now populated by
story 2.2), walks each entry, fetches the `SKILL.md` from the federation
source's GitHub raw URL, verifies the SHA, and writes to
`.claude/skills/<name>/SKILL.md`. **This is the step that puts SKILL.md
files on disk** — without it, Claude Code's auto-discovery has nothing
to find.

### Where it slots

After `npm-install` (the `yaml` parsing dep is now on disk so the script
can `require('yaml')` cleanly), before `bmad-bootstrap`.

### Code shape

```js
// daemon/lib/app-bootstrap-steps/vendor-skills.mjs (NEW)

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const TIMEOUT_MS = 120_000; // 2 min — 4 skills × ~5 GitHub raw fetches
const SYNC_SCRIPT_REL = 'scripts/skills-sync.mjs';

export async function runVendorSkills({ worktreeDir, skip, onOutput }) {
  if (skip) {
    return { skipped: true, reason: 'stub-boilerplate', vendoredCount: 0 };
  }

  const scriptPath = join(worktreeDir, SYNC_SCRIPT_REL);
  if (!existsSync(scriptPath)) {
    return { skipped: true, reason: 'sync-script-missing', vendoredCount: 0 };
  }

  return new Promise((resolve) => {
    const proc = spawn('node', [SYNC_SCRIPT_REL], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        FUTURATOR_FEDERATION_PATH:
          process.env.FUTURATOR_FEDERATION_PATH || '/home/ubuntu/.futurator/skill-federation.yaml',
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onOutput?.('stdout', s);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onOutput?.('stderr', s);
    });

    const timer = setTimeout(() => proc.kill('SIGKILL'), TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Parse "[skills-sync] WROTE <skill>@<source>" lines for count.
      const vendored = (stdout.match(/^\[skills-sync\] WROTE /gm) || []).length;
      const drift = (stdout.match(/^\[skills-sync\] DRIFT /gm) || []).length;

      // Exit codes per skills-sync.mjs contract:
      //   0 = clean sync, 1 = fatal, 2 = drift detected (operator resync).
      // 2 = soft-fail; emit attention but don't fail bootstrap.
      if (code === 0) {
        resolve({ skipped: false, vendoredCount: vendored, drift: 0 });
      } else if (code === 2) {
        resolve({
          skipped: false,
          vendoredCount: vendored,
          drift,
          attentionCategory: 'skill-manifest-out-of-sync', // v2.5 Appendix C
        });
      } else {
        // code 1 OR signal kill → hard fail but non-blocking (epic 2 must not
        // regress brick-breaker-style bootstrap success). Surface attention.
        resolve({
          skipped: true,
          reason: `sync-failed-exit-${code}`,
          vendoredCount: 0,
          attentionCategory: 'skill-sync-failed',
          stderr: stderr.slice(0, 500),
        });
      }
    });
  });
}
```

### Wire-in (continuation from story 2.2)

```js
// daemon/pipelines/app-bootstrap.mjs

import { runVendorSkills } from '../lib/app-bootstrap-steps/vendor-skills.mjs';

// After npm-install (around line 263):
await emitStarted('vendor-skills');
const vendorResult = await stepFns.vendorSkills({
  worktreeDir,
  skip: view.isStub === true,
  onOutput: makeOutputSink('vendor-skills'),
});
await emitCompleted('vendor-skills', {
  skipped: !!vendorResult.skipped,
  reason: vendorResult.reason,
  vendoredCount: vendorResult.vendoredCount,
  drift: vendorResult.drift,
});

// Surface attention if vendor failed:
if (vendorResult.attentionCategory) {
  await writeAttentionItem?.({
    appId,
    planId: null,
    category: vendorResult.attentionCategory,
    severity: vendorResult.attentionCategory === 'skill-sync-failed' ? 'medium' : 'low',
    title: `Skill vendor: ${vendorResult.reason ?? 'drift detected'} for ${appId}`,
    body:
      vendorResult.stderr ||
      `vendoredCount=${vendorResult.vendoredCount} drift=${vendorResult.drift}`,
    dedupKey: `skill-sync-${vendorResult.attentionCategory}:${appId}`,
  });
}
```

### Concrete sync behavior for `nextjs-canvas-game`

Given Story 2.1's loadout, after Story 2.3 runs:

```
/home/ubuntu/projects/<app>/.claude/skills/
├── canvas-design/
│   └── SKILL.md           ← fetched from anthropics/skills@<sha>
├── frontend-design/
│   └── SKILL.md
└── algorithmic-art/
    └── SKILL.md
```

All three SKILL.md files become part of the commit-and-push step's
git add (the boilerplate's `.claude/skills/.gitignore` lets `*/SKILL.md`
through).

### Tests

`daemon/lib/app-bootstrap-steps/__tests__/vendor-skills.test.mjs` (NEW):

```js
describe('vendor-skills', () => {
  it('skips when isStub=true', async () => {
    /* ... */
  });
  it('skips when scripts/skills-sync.mjs missing', async () => {
    /* ... */
  });
  it('counts WROTE lines from stdout', async () => {
    // Mock spawn → simulate stdout "[skills-sync] WROTE canvas-design@anthropic-official ..."
    // Assert vendoredCount === 1
  });
  it('returns attention category on exit-2 drift', async () => {
    /* ... */
  });
  it('non-blocking on exit-1 fatal', async () => {
    const r = await runVendorSkills({ worktreeDir: '/nonexistent' });
    expect(r.skipped).toBe(true);
    expect(r.attentionCategory).toBe('skill-sync-failed');
  });
});
```

### Federation dependency note

`skills-sync.mjs` reads `~/.futurator/skill-federation.yaml` (overridable
via `FUTURATOR_FEDERATION_PATH`). The federation file MUST exist with
the `anthropic-official` source entry before this step can succeed.

- If Epic 1.2 hasn't shipped yet (operator hasn't authored the file),
  the script's `die('federation missing: ...')` triggers exit code 1,
  surfacing `skill-sync-failed` attention. Bootstrap still completes.
- **Recommended:** ship Epic 1.2 (one-line operator action) before
  enabling Epic 2 in production. The 15-min cost makes the difference
  between "works on first new app" and "first app surfaces a fixable
  attention item."

---

## 4. Story 2.4 — E2E validation

**Effort:** 30 min · **Files touched:** 0 (verification only)

### Procedure

1. Land Stories 2.1 + 2.2 + 2.3 on a feature branch, deploy via `sst deploy`.
2. SSH to the daemon EC2 host (per CLAUDE.md §"Quick links" — `54.86.226.233`).
3. Create a fresh app via admin UI: name `dino-test-2`, boilerplate `nextjs-canvas-game`.
4. Wait for app-bootstrap to complete (status `active`).
5. Run validation queries below.

### Validation queries

```bash
# A) SKILL.md files on disk
ssh ec2 'ls /home/ubuntu/projects/dino-test-2/.claude/skills/'
# Expect: algorithmic-art canvas-design frontend-design

ssh ec2 'wc -l /home/ubuntu/projects/dino-test-2/.claude/skills/canvas-design/SKILL.md'
# Expect: > 0 lines (real content from anthropics/skills)

# B) Manifest pinned
ssh ec2 'cat /home/ubuntu/projects/dino-test-2/.claude/skills.manifest.yaml'
# Expect: core: with 3 entries; stack/domain/vendor still empty

# C) SKILL.md files committed
ssh ec2 'cd /home/ubuntu/projects/dino-test-2 && git ls-files .claude/skills/'
# Expect: 3 SKILL.md paths (gitignore lets *.md through; bodies stay local)

# D) Bootstrap forensic emits prepin + vendor events
aws dynamodb query --table-name futurator-agent-events --region us-east-1 \
  --key-condition-expression "jobId = :j" \
  --expression-attribute-values '{":j":{"S":"<bootstrap-jobId>"}}' \
  --filter-expression "contains(eventType, :p) OR contains(eventType, :v)" \
  --expression-attribute-values '{":j":{"S":"<bootstrap-jobId>"},":p":{"S":"prepin-default-skills"},":v":{"S":"vendor-skills"}}' \
  --output json | jq '.Items | length'
# Expect: 4 (started + completed for each)
```

### Acceptance — green to ship

- All four queries A/B/C/D return expected results.
- Bootstrap total wall-clock didn't grow by more than 60s
  (vendor-skills is the new heavy step; budget 30s for 3 GitHub raw fetches).
- No `skill-sync-failed` or `skill-manifest-out-of-sync` attention items
  on the new app row.

### Then: run a real plan against `dino-test-2`

Create a small plan ("Show a 16x16 pixel-art snake head") under mvp
rigor. After plan close, capture the forensic and compare to
`plan_snake-4_mpcdwkto-forensic.json` (the pre-Epic-2 baseline):

| Metric                              | snake-4 baseline                                        | dino-test-2 target                                        |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Total cost                          | $9.02                                                   | within ±20% (skills add prompt size, may save retries)    |
| Story retry count (review failures) | 0 stories needed retry (all green wave-0)               | ≤ baseline                                                |
| `claude_md_loaded` sha consistency  | same across all 36 agent invocations (CLAUDE.md static) | same (CLAUDE.md write hooks are Epic 5, not 2)            |
| **NEW: skill activation evidence**  | n/a                                                     | DEV agent's text_delta events reference canvas-design ≥1× |

The headline number is the **NEW row** — that's the qualitative proof
skills affected agent behavior. Quantitative gains (cost, retries) take
3–5 plan runs to show signal above noise.

---

## 5. Rollback plan

Each story is independently revertible:

- **2.1 rollback:** revert the registry edit; no runtime impact (field returns to `undefined`).
- **2.2 rollback:** remove the step from `app-bootstrap.mjs` AND remove `'prepin-default-skills'` from the `PostCreateStep` type union. Manifests of already-bootstrapped apps stay pinned (harmless).
- **2.3 rollback:** remove the step. Apps with vendored SKILL.md files keep them (still git-tracked). Future bootstraps simply skip vendoring.

Full Epic 2 rollback restores pre-state — empty manifests + no `.claude/skills/<n>/` dirs in new apps. No data loss.

---

## 6. Sequencing decisions

### Should Story 2.0 block 2.1?

**No.** 2.1 is pure data, no runtime impact. Land it any time. **2.0 blocks 2.2 + 2.3.**

### Should we ship Stories 2.2 + 2.3 atomically?

**Yes.** 2.2 without 2.3 leaves new apps with a non-empty manifest but
no SKILL.md files on disk — partially-failed state that surfaces
`skill-manifest-out-of-sync` attention (correctly, but noisily) for
every new app until 2.3 ships. Bundle them in one PR.

### What if Epic 1 (federation file) hasn't shipped yet?

Epic 2 can still ship — the `vendor-skills` step will fail soft (exit
code 1, attention surfaced, bootstrap completes). The new app shows up
in the dashboard with a `skill-sync-failed` attention; operator can
either author the federation file then retry (recommended) or
acknowledge the attention and move on.

### Boilerplate version bump?

The boilerplate template repos (`futurator-repos/template-nextjs` etc.)
DON'T need changes — `.claude/skills.manifest.yaml`, `scripts/skills-sync.mjs`,
and `.claude/skills/.gitignore` all come from the daemon's augment
files (`SKILL_MANIFEST_AUGMENTS` in `registry.ts:641`), not the template
repo. So Epic 2 ships without a template bump.

---

## 7. Open questions

1. **Skill description vs. activation.** Claude Code activates a skill
   when the prompt content matches the skill's `description` frontmatter.
   A DEV agent doing "Cap newSpeedLevel at 10 in snakeReducer" may NOT
   trigger `canvas-design` (state-machine story, not rendering). This
   means **per-story activation is opportunistic**; the value compounds
   across many stories. A/B the plan-level metrics (cost, retry rate),
   not per-story.

2. **Skill content size impact on prompt cache.** Each SKILL.md is
   typically 2–10KB. 3 skills × 5KB × 5 agents × 7 stories ≈ 525KB
   extra context per plan. Anthropic's prompt cache applies — after the
   first agent in a plan loads them, subsequent agents hit cached
   tokens (5-min TTL). Marginal cost: probably under $0.01 per plan,
   but **measure before/after**.

3. **SHA pinning at prepin time.** Current spec uses `version: 'sha:HEAD'`
   which means `skills-sync.mjs` fetches the source repo's HEAD on first
   sync. This is fine for prototype/mvp but **production rigor requires
   SHA-only pins** (v2.5 §42). For Epic 2 we accept HEAD-pin; SKILL-SCOUT
   T8 weekly refresh (Epic 3 follow-on) replaces with specific SHAs.

4. **Removing skills.** If we want to remove a default skill from a
   starter, existing apps would still have it pinned. The skill
   lifecycle's `retire` step (v2.5 §39 step 8) is the path — Epic 6
   (REFLECTOR) work. Out of scope for Epic 2.

5. **GitHub rate limits.** `skills-sync.mjs` does unauthenticated `fetch`
   calls to `raw.githubusercontent.com`. Public rate limit is 60/hour
   per IP. With 3 fetches per app bootstrap and bursty operator behavior,
   we could hit it. Mitigation: set `GITHUB_PAT` env var on the daemon
   (uses the existing `/futurator/_pipeline/github-pat` SSM) so the
   sync script uses an authenticated `Authorization: Bearer ...` header
   per the `skills-sync.mjs:556` code path (`if (process.env.GITHUB_PAT)
headers.Authorization = ...`). Already plumbed — just verify on EC2.

---

## 8. Definition of Done

- [ ] Story 2.0 probes ran, results documented inline in this file as a §9 (or pivot decision documented)
- [ ] Story 2.1 PR merged: `defaultSkillLoadout` populated for 4 wired starters + 3 stub starters declared null; tests green
- [ ] Story 2.2 PR merged: `prepin-default-skills.mjs` + tests; bootstrap step wired between `apply-starter-augments` and `npm-install`
- [ ] Story 2.3 PR merged: `vendor-skills.mjs` + tests; bootstrap step wired between `npm-install` and `bmad-bootstrap`
- [ ] Story 2.4 verified on a fresh `dino-test-2` app: SKILL.md files on disk, manifest pinned, all 3 files committed
- [ ] Forensic captured for a small plan on `dino-test-2`; saved under `docs/concepts/logs/dino-test-2-<date>/`
- [ ] Comparative observations appended to §12 of `plan-skills-activation.md`
- [ ] If 2.4 surfaces any attention items, root cause investigated and either fixed or filed as a follow-on story

---

_Authored 2026-05-19 against HEAD `feat/treesitter-slice-c-brownfield-bootstrap`._
_Parent: `plan-skills-activation.md`. Predecessor for Epics 3, 4, 5, 6, 7._
