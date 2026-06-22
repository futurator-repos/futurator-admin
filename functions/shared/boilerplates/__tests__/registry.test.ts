import { describe, it, expect } from 'vitest';
import {
  BOILERPLATE_REGISTRY,
  getBoilerplateMetadata,
  getWiredBoilerplateTypes,
} from '../registry';
import type { BoilerplateType } from '../registry';

// All members of the union, kept in sync manually. If you add a new
// BoilerplateType and forget to add it here the tests below will catch it.
// PR-13 — `nextjs` renamed to `nextjs-base`; new starter packs added.
const ALL_TYPES: BoilerplateType[] = [
  'nextjs-base',
  'nextjs-canvas-game',
  'nextjs-form-app',
  'nextjs-dashboard',
  'sst',
  'vite',
  'mobile',
];

describe('BOILERPLATE_REGISTRY — structural coverage', () => {
  it('has an entry for every BoilerplateType', () => {
    const registeredKeys = Object.keys(BOILERPLATE_REGISTRY);
    expect(registeredKeys.sort()).toEqual([...ALL_TYPES].sort());
  });

  it.each(ALL_TYPES)('%s — all required fields are non-empty', (type) => {
    const meta = BOILERPLATE_REGISTRY[type];

    expect(meta.type).toBe(type);
    expect(meta.displayName.length).toBeGreaterThan(0);
    expect(meta.icon.length).toBeGreaterThan(0);
    expect(meta.templateRepo.length).toBeGreaterThan(0);
    expect(['wired', 'stub']).toContain(meta.status);
    expect(typeof meta.bmadSupported).toBe('boolean');

    // defaultStack
    expect(meta.defaultStack.runtime.length).toBeGreaterThan(0);
    expect(meta.defaultStack.packageManager.length).toBeGreaterThan(0);
    expect(meta.defaultStack.testCommand.length).toBeGreaterThan(0);
    expect(meta.defaultStack.devCommand.length).toBeGreaterThan(0);
    expect(meta.defaultStack.buildCommand.length).toBeGreaterThan(0);
  });

  it.each(ALL_TYPES.filter((t) => BOILERPLATE_REGISTRY[t].status === 'wired'))(
    '%s (wired) — postCreateSteps is non-empty',
    (type) => {
      const { postCreateSteps } = BOILERPLATE_REGISTRY[type];
      expect(postCreateSteps.length).toBeGreaterThan(0);
    },
  );

  it.each(ALL_TYPES.filter((t) => BOILERPLATE_REGISTRY[t].bmadSupported === true))(
    '%s — bmadSupported=true implies bmad-bootstrap step is present',
    (type) => {
      const { postCreateSteps } = BOILERPLATE_REGISTRY[type];
      const hasBmadStep = postCreateSteps.some((step) => step.id === 'bmad-bootstrap');
      expect(hasBmadStep).toBe(true);
    },
  );
});

describe('getBoilerplateMetadata', () => {
  it('returns the metadata for a known type', () => {
    const meta = getBoilerplateMetadata('nextjs-base');
    expect(meta.type).toBe('nextjs-base');
    expect(meta.status).toBe('wired');
    expect(meta.bmadSupported).toBe(true);
  });

  it('throws for an unknown type', () => {
    expect(() =>
      // Cast to bypass type-safety — simulates an untrusted runtime value.
      getBoilerplateMetadata('unknown' as BoilerplateType),
    ).toThrow('unknown boilerplate type: unknown');
  });
});

describe('getWiredBoilerplateTypes', () => {
  it('includes nextjs-base + nextjs-canvas-game (PR-13 Phase 1)', () => {
    const wired = getWiredBoilerplateTypes();
    expect(wired).toContain('nextjs-base');
    expect(wired).toContain('nextjs-canvas-game');
  });

  it('returns only types whose status is wired', () => {
    const wired = getWiredBoilerplateTypes();
    for (const type of wired) {
      expect(BOILERPLATE_REGISTRY[type].status).toBe('wired');
    }
  });
});

describe('nextjs-base registry entry — spot-check AC values', () => {
  const meta = BOILERPLATE_REGISTRY['nextjs-base'];

  it('has the correct templateRepo', () => {
    expect(meta.templateRepo).toBe('futurator-repos/template-nextjs');
  });

  it('has exactly 4 postCreateSteps in the right order', () => {
    const ids = meta.postCreateSteps.map((s) => s.id);
    expect(ids).toEqual(['inject-app-values', 'npm-install', 'bmad-bootstrap', 'commit-and-push']);
  });

  it('inject-app-values targets the correct files', () => {
    const injectStep = meta.postCreateSteps.find((s) => s.id === 'inject-app-values');
    // PR-71 (Story 3-C-2-1) extended this list with .claude/skills.manifest.yaml
    // so the `project: __APP_SLUG__` placeholder is substituted at bootstrap.
    expect(injectStep?.targetFiles).toEqual([
      'package.json',
      'README.md',
      'CLAUDE.md',
      '.claude/skills.manifest.yaml',
    ]);
  });

  it('defaultStack matches the nextjs AC spec', () => {
    expect(meta.defaultStack).toMatchObject({
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    });
  });
});

describe('PR-13 — starter pack inheritance', () => {
  it('nextjs-canvas-game inherits postCreateSteps from nextjs-base', () => {
    const base = BOILERPLATE_REGISTRY['nextjs-base'];
    const cg = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(cg.postCreateSteps).toEqual(base.postCreateSteps);
  });

  it('nextjs-canvas-game declares baseStarter + augmentFiles + scaffoldContract', () => {
    const cg = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(cg.baseStarter).toBe('nextjs-base');
    expect(cg.domain).toBe('game');
    expect(Array.isArray(cg.augmentFiles)).toBe(true);
    expect((cg.augmentFiles ?? []).length).toBeGreaterThan(0);
    expect(cg.scaffoldContract?.length ?? 0).toBeGreaterThan(0);
  });

  it('nextjs-canvas-game first augment file is SCAFFOLD.md mirroring scaffoldContract', () => {
    const cg = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(cg.augmentFiles?.[0].path).toBe('SCAFFOLD.md');
    expect(cg.augmentFiles?.[0].content).toBe(cg.scaffoldContract);
  });

  it('nextjs-canvas-game augments include the documented primitives', () => {
    const cg = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    const paths = (cg.augmentFiles ?? []).map((f) => f.path);
    for (const required of [
      'src/game/types.ts',
      'src/game/physics.ts',
      'src/game/state-machine.ts',
      'src/hooks/useGameLoop.ts',
      'src/hooks/useKeyboard.ts',
      'src/components/GameCanvas.tsx',
    ]) {
      expect(paths).toContain(required);
    }
  });
});

describe('stub types — spot-check', () => {
  // PR-13: nextjs-form-app + nextjs-dashboard are also stubs in Phase 1.
  // bmadSupported follows the parent (nextjs-base) so they STILL inherit
  // bmad-bootstrap as a post-create step.
  it.each(['sst', 'vite', 'mobile'] as BoilerplateType[])(
    '%s has status stub and bmadSupported=false',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.status).toBe('stub');
      expect(meta.bmadSupported).toBe(false);
    },
  );

  it.each(['nextjs-form-app', 'nextjs-dashboard'] as BoilerplateType[])(
    '%s — Phase 1 stub, inherits bmadSupported=true from nextjs-base',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.status).toBe('stub');
      expect(meta.bmadSupported).toBe(true);
    },
  );

  it('mobile uses react-native runtime and expo commands', () => {
    const meta = BOILERPLATE_REGISTRY['mobile'];
    expect(meta.defaultStack.runtime).toBe('react-native');
    expect(meta.defaultStack.devCommand).toBe('npx expo start');
    expect(meta.defaultStack.buildCommand).toBe('npx expo build');
  });
});

describe('PR-35 — baseline-diff regression gate', () => {
  it('nextjs-base declares baselineCapture pointing at the shipped scripts', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    expect(meta.baselineCapture).not.toBeNull();
    expect(meta.baselineCapture?.scriptPath).toBe('scripts/capture-test-baseline.sh');
    expect(meta.baselineCapture?.regressCheckPath).toBe('scripts/check-regressions.sh');
    expect(meta.baselineCapture?.testRunner).toBe('vitest');
  });

  it.each(['nextjs-canvas-game', 'nextjs-form-app', 'nextjs-dashboard'] as BoilerplateType[])(
    '%s — inherits baselineCapture from nextjs-base',
    (type) => {
      const base = BOILERPLATE_REGISTRY['nextjs-base'];
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.baselineCapture).toEqual(base.baselineCapture);
    },
  );

  it.each(['sst', 'vite', 'mobile'] as BoilerplateType[])(
    '%s (stub) — declares baselineCapture: null so daemon skips the gate',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.baselineCapture).toBeNull();
    },
  );
});

describe('PR-71 — Project skill manifest (Story 3-C-2-1)', () => {
  it('nextjs-base declares skillManifest pointing at the shipped paths', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    expect(meta.skillManifest).not.toBeNull();
    expect(meta.skillManifest?.manifestPath).toBe('.claude/skills.manifest.yaml');
    expect(meta.skillManifest?.syncScriptPath).toBe('scripts/skills-sync.mjs');
  });

  it.each(['nextjs-canvas-game', 'nextjs-form-app', 'nextjs-dashboard'] as BoilerplateType[])(
    '%s — inherits skillManifest from nextjs-base',
    (type) => {
      const base = BOILERPLATE_REGISTRY['nextjs-base'];
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.skillManifest).toEqual(base.skillManifest);
    },
  );

  it.each(['sst', 'vite', 'mobile'] as BoilerplateType[])(
    '%s (stub) — declares skillManifest: null so daemon skips SKILL-SCOUT',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.skillManifest).toBeNull();
    },
  );

  // ── Epic 2 Story 2.1 — defaultSkillLoadout (2026-05-19) ──────────────────
  //
  // The base + canvas-game + dashboard loadouts are the documented v1 set
  // (per `docs/concepts/pipeline-v2/tech-spec-epic-2-default-skill-loadout.md`
  // §1). form-app inherits from base; stubs declare null. SKILL.md activation
  // happens via Claude Code's built-in Skill tool on prompt-relevance match
  // (verified by the Story 2.0 probe; see docs/concepts/logs/skills-probe-2026-05-19/).

  it('nextjs-base declares the base defaultSkillLoadout', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    expect(meta.defaultSkillLoadout).toEqual([
      'frontend-design@anthropic-official',
      'webapp-testing@anthropic-official',
    ]);
  });

  it('nextjs-canvas-game overrides with canvas-design + frontend-design + algorithmic-art', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(meta.defaultSkillLoadout).toEqual([
      'canvas-design@anthropic-official',
      'frontend-design@anthropic-official',
      'algorithmic-art@anthropic-official',
    ]);
  });

  it('nextjs-form-app inherits the base loadout (no override)', () => {
    const base = BOILERPLATE_REGISTRY['nextjs-base'];
    const meta = BOILERPLATE_REGISTRY['nextjs-form-app'];
    expect(meta.defaultSkillLoadout).toEqual(base.defaultSkillLoadout);
  });

  it('nextjs-dashboard overrides with frontend-design only', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-dashboard'];
    expect(meta.defaultSkillLoadout).toEqual(['frontend-design@anthropic-official']);
  });

  it.each(['sst', 'vite', 'mobile'] as BoilerplateType[])(
    '%s (stub) — declares defaultSkillLoadout: null so daemon skips prepin + vendor',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.defaultSkillLoadout).toBeNull();
    },
  );

  it('every nextjs-* loadout entry is a non-empty "<skill>@<source>" token', () => {
    const nextjsTypes: BoilerplateType[] = [
      'nextjs-base',
      'nextjs-canvas-game',
      'nextjs-form-app',
      'nextjs-dashboard',
    ];
    for (const type of nextjsTypes) {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.defaultSkillLoadout, `${type} has a loadout`).not.toBeNull();
      for (const token of meta.defaultSkillLoadout ?? []) {
        expect(token, `${type} token shape`).toMatch(/^[a-z0-9-]+@[a-z0-9-]+$/);
        const [skill, source] = token.split('@');
        expect(skill.length, `${type} skill name`).toBeGreaterThan(0);
        expect(source.length, `${type} source id`).toBeGreaterThan(0);
      }
    }
  });

  it('every loadout source matches a federation source id (anthropic-official only in v1)', () => {
    // The embedded-default federation declares these source ids. When
    // Epic 1.1 ships `futurator-internal` content + Epic 1.2 authors a
    // real ~/.futurator/skill-federation.yaml, this test will need
    // updating to widen the allowed source set.
    const KNOWN_SOURCES = new Set(['anthropic-official', 'futurator-internal']);
    const nextjsTypes: BoilerplateType[] = [
      'nextjs-base',
      'nextjs-canvas-game',
      'nextjs-form-app',
      'nextjs-dashboard',
    ];
    for (const type of nextjsTypes) {
      for (const token of BOILERPLATE_REGISTRY[type].defaultSkillLoadout ?? []) {
        const source = token.split('@')[1];
        expect(KNOWN_SOURCES, `${type} token ${token} source`).toContain(source);
      }
    }
  });

  it('canvas-game references at least one canvas-specific skill (regression guard)', () => {
    // Whole point of the canvas-game override: pick skills that wouldn't
    // bubble up from the base loadout. Drift back to the base set is a
    // silent regression of the starter's value proposition.
    const meta = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    const skillNames = (meta.defaultSkillLoadout ?? []).map((t) => t.split('@')[0]);
    expect(skillNames).toContain('canvas-design');
  });

  it('nextjs-base ships the empty manifest + sync script + gitignore as augment files', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const paths = (meta.augmentFiles ?? []).map((f) => f.path);
    expect(paths).toContain('.claude/skills.manifest.yaml');
    expect(paths).toContain('scripts/skills-sync.mjs');
    expect(paths).toContain('.claude/skills/.gitignore');
  });

  it('empty manifest contains the slug placeholder for inject-app-values', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const manifest = (meta.augmentFiles ?? []).find(
      (f) => f.path === '.claude/skills.manifest.yaml',
    );
    expect(manifest?.content).toMatch(/project: __APP_SLUG__/);
  });

  it('nextjs-base ships the two shell scripts as augment files', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const paths = (meta.augmentFiles ?? []).map((f) => f.path);
    expect(paths).toContain('scripts/capture-test-baseline.sh');
    expect(paths).toContain('scripts/check-regressions.sh');
    expect(paths).toContain('.pipeline/.gitignore');
  });

  it('shell scripts are bash-shebanged and reference jq + comm', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const capture = meta.augmentFiles?.find((f) => f.path === 'scripts/capture-test-baseline.sh');
    const check = meta.augmentFiles?.find((f) => f.path === 'scripts/check-regressions.sh');
    expect(capture?.content.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(capture?.content).toContain('jq');
    expect(check?.content.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(check?.content).toContain('comm -23');
    expect(check?.content).toContain('BASELINE_REGRESSION_DETECTED');
    expect(check?.content).toContain('TEST_RUNNER_FAILURE');
  });

  it('starter packs inherit the baseline-diff augments AND keep their own', () => {
    const base = BOILERPLATE_REGISTRY['nextjs-base'];
    const cg = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    const basePaths = new Set((base.augmentFiles ?? []).map((f) => f.path));
    const cgPaths = (cg.augmentFiles ?? []).map((f) => f.path);
    // Every base augment is present in canvas-game.
    for (const p of basePaths) {
      expect(cgPaths, `canvas-game inherits ${p}`).toContain(p);
    }
    // Canvas-game also has its own (e.g. SCAFFOLD.md, src/game/types.ts).
    expect(cgPaths).toContain('SCAFFOLD.md');
    expect(cgPaths).toContain('src/game/types.ts');
  });
});

describe('PR-41 — frozen-file pre-commit hook (Story 2-A-5-2)', () => {
  it('nextjs-base ships .husky/pre-commit-frozen as an augment', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const paths = (meta.augmentFiles ?? []).map((f) => f.path);
    expect(paths).toContain('.husky/pre-commit-frozen');
  });

  it('hook is a bash script that reads .pipeline/frozen.txt', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const hook = meta.augmentFiles?.find((f) => f.path === '.husky/pre-commit-frozen');
    expect(hook?.content.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(hook?.content).toContain('.pipeline/frozen.txt');
    expect(hook?.content).toContain('git diff --cached --name-only');
    expect(hook?.content).toContain('BLOCKED');
  });

  it('hook is no-op when frozen.txt missing (legacy + fresh-clone safe)', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const hook = meta.augmentFiles?.find((f) => f.path === '.husky/pre-commit-frozen');
    expect(hook?.content).toContain('exit 0');
    expect(hook?.content).toMatch(/if \[ ! -f \.pipeline\/frozen\.txt/);
  });

  it.each(['nextjs-canvas-game', 'nextjs-form-app', 'nextjs-dashboard'] as BoilerplateType[])(
    '%s — inherits the frozen-file hook from nextjs-base',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      const paths = (meta.augmentFiles ?? []).map((f) => f.path);
      expect(paths).toContain('.husky/pre-commit-frozen');
    },
  );

  // Story D (agentic-integration, 2026-05-29) — generated-wiring primitive.
  it.each([
    'nextjs-base',
    'nextjs-canvas-game',
    'nextjs-form-app',
    'nextjs-dashboard',
  ] as BoilerplateType[])('%s — ships the feature-registry generated-wiring augments', (type) => {
    const meta = BOILERPLATE_REGISTRY[type];
    const paths = (meta.augmentFiles ?? []).map((f) => f.path);
    expect(paths).toContain('scripts/generate-wiring.mjs');
    expect(paths).toContain('src/features/README.md');
    expect(paths).toContain('.gitattributes');
  });

  it('the generate-wiring augment is a runnable, dependency-free node script', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-base'];
    const gen = meta.augmentFiles?.find((f) => f.path === 'scripts/generate-wiring.mjs');
    expect(gen?.content).toContain('src/features');
    expect(gen?.content).toContain('page.tsx');
    expect(gen?.content).toContain("from 'node:fs'"); // node built-ins only
  });

  it.each(['nextjs-base', 'nextjs-canvas-game'] as BoilerplateType[])(
    '%s — post-merge gate regenerates wiring before the build',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.postMergeValidationCmd).toContain('generate-wiring.mjs');
      expect(meta.postMergeValidationCmd).toContain('npm run build');
    },
  );

  it('canvas-game scaffold contract forbids hand-editing the generated page.tsx', () => {
    const meta = BOILERPLATE_REGISTRY['nextjs-canvas-game'];
    expect(meta.scaffoldContract).toMatch(/generated/i);
    expect(meta.scaffoldContract).toContain('src/features/');
    expect(meta.scaffoldContract).toMatch(/NEVER hand-edit|DO NOT edit|never.*edit/i);
  });
});

// ── v2.6 — wave-gate quality plumbing (2026-06-11) ─────────────────────────
describe('v2.6 — wave-gate quality plumbing', () => {
  const base = BOILERPLATE_REGISTRY['nextjs-base'];

  it.each([
    'nextjs-base',
    'nextjs-canvas-game',
    'nextjs-form-app',
    'nextjs-dashboard',
  ] as BoilerplateType[])('%s — ships the quality-infra augments', (type) => {
    const paths = (BOILERPLATE_REGISTRY[type].augmentFiles ?? []).map((f) => f.path);
    for (const p of [
      '.prettierrc',
      '.prettierignore',
      'knip.json',
      'lint-staged.config.mjs',
      '.husky/pre-commit',
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it('pins the quality toolchain in template-owned devDependencies', () => {
    const deps = base.packageJsonDevDependencies ?? {};
    for (const d of ['prettier', 'knip', 'husky', 'lint-staged']) {
      expect(deps[d], d).toBeTruthy();
    }
  });

  it('ships quality npm scripts including husky prepare', () => {
    const scripts = base.packageJsonScripts ?? {};
    expect(scripts.format).toContain('prettier --write');
    expect(scripts['format:check']).toContain('prettier --check');
    expect(scripts.knip).toBe('knip');
    expect(scripts.prepare).toBe('husky');
  });

  it('pre-commit hook chains the frozen-file guard, then mechanical-only fixes', () => {
    const hook = base.augmentFiles?.find((f) => f.path === '.husky/pre-commit');
    expect(hook?.content).toContain('.husky/pre-commit-frozen');
    // Frozen guard is blocking; mechanical part never fails a commit.
    expect(hook?.content).toContain('bash .husky/pre-commit-frozen || exit 1');
    expect(hook?.content).toContain('npx lint-staged --quiet || true');
    // Fast no-op below production rigor.
    expect(hook?.content).toMatch(/"\$RIGOR" = "production"/);
  });

  it('declares rigor-composed qualityGate stages (tiers compose up)', () => {
    const gate = base.qualityGate;
    expect(gate).toBeTruthy();
    // Mechanical stage is self-guarding and includes the wiring generator.
    expect(gate?.mechanical.join(' ')).toContain('generate-wiring.mjs');
    expect(gate?.mechanical.join(' ')).toContain('eslint . --fix');
    // Every blocking tier builds; mvp adds tests + lint budget; production
    // tightens to zero warnings and adds knip + format:check.
    for (const tier of ['prototype', 'mvp', 'production'] as const) {
      expect(gate?.blocking[tier].join(' '), tier).toContain('npm run build');
    }
    expect(gate?.blocking.mvp.join(' ')).toContain('--max-warnings 200');
    expect(gate?.blocking.production.join(' ')).toContain('--max-warnings 0');
    expect(gate?.blocking.production.join(' ')).toContain('knip');
    expect(gate?.blocking.production.join(' ')).toContain('format:check');
  });

  it('keeps the legacy postMergeValidationCmd as the runner fallback', () => {
    expect(base.postMergeValidationCmd).toContain('npm run build');
  });

  it('knip.json treats feature-registry modules as entries (never "unused")', () => {
    const knip = base.augmentFiles?.find((f) => f.path === 'knip.json');
    expect(knip?.content).toContain('src/features/*.feature.tsx');
  });

  it('.prettierignore excludes the generated page and pipeline dirs', () => {
    const ignore = base.augmentFiles?.find((f) => f.path === '.prettierignore');
    expect(ignore?.content).toContain('src/app/page.tsx');
    expect(ignore?.content).toContain('.pipeline');
  });
});

describe('nextjs-canvas-game — VQA v3 verifiability seam (E2)', () => {
  const game = BOILERPLATE_REGISTRY['nextjs-canvas-game'];

  it('declares a testHarness contract with the generator-owned snapshot shape', () => {
    expect(game.testHarness?.globalKey).toBe('window.__harness');
    expect(game.testHarness?.readySignal).toBe('ready');
    const shape = game.testHarness?.snapshotShape ?? {};
    // The keys probes assert against must be declared.
    for (const key of [
      'snapshot.status',
      'snapshot.score',
      'snapshot.entities',
      'snapshot.gameOver',
    ]) {
      expect(shape[key]).toBeDefined();
    }
    expect(shape['snapshot.status'].enum).toContain('running');
  });

  it('ships the seam in the state-machine scaffold, PRODUCTION-ABSENT (env-guarded)', () => {
    const sm = game.augmentFiles?.find((f) => f.path === 'src/game/state-machine.ts');
    expect(sm?.content).toContain('window.__harness');
    // The guard is what keeps the seam out of production builds — assert it
    // exists and is the canonical NEXT_PUBLIC_TEST_HARNESS check.
    expect(sm?.content).toContain("process.env.NEXT_PUBLIC_TEST_HARNESS !== '1'");
    // The publish must happen INSIDE the guard (early-return before it).
    const guardIdx = sm!.content.indexOf('NEXT_PUBLIC_TEST_HARNESS');
    const publishIdx = sm!.content.indexOf('.__harness =');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(guardIdx);
  });

  it('SCAFFOLD.md tells DEV the seam is pre-baked (do not author it)', () => {
    expect(game.scaffoldContract).toMatch(/__harness/);
    expect(game.scaffoldContract).toMatch(/PRE-BAKED|do NOT author/i);
  });

  it('SCAFFOLD.md forbids testing the feature descriptor (promote-to-primary disease)', () => {
    // slug/order/primary are mutated by the promotion lifecycle — freezing them
    // in a unit test makes the assembly story's contract unsatisfiable.
    expect(game.scaffoldContract).toMatch(/DESCRIPTOR is NOT a test surface/);
    expect(game.scaffoldContract).toMatch(/NEVER write a test that asserts/);
    expect(game.scaffoldContract).toMatch(/feature\.slug/);
  });

  it('ships a committed __harness.schema.json that matches testHarness.snapshotShape (E5.5)', () => {
    const file = game.augmentFiles?.find((f) => f.path === '__harness.schema.json');
    expect(file).toBeDefined();
    const schema = JSON.parse(file!.content) as {
      globalKey: string;
      snapshot: Record<string, { type: string; enum?: string[] }>;
      events: unknown[];
    };
    expect(schema.globalKey).toBe('window.__harness');
    expect(Array.isArray(schema.events)).toBe(true);
    // The schema's snapshot map must be exactly the testHarness shape, minus
    // the `snapshot.` jsonPath prefix — single source of truth (no drift).
    const fromContract = Object.fromEntries(
      Object.entries(game.testHarness!.snapshotShape).map(([k, v]) => [
        k.replace(/^snapshot\./, ''),
        v,
      ]),
    );
    expect(schema.snapshot).toEqual(fromContract);
  });
});

describe('nextjs-dashboard — generic app-state seam + non-game scaffold contract (D1-A6/A7)', () => {
  const dash = BOILERPLATE_REGISTRY['nextjs-dashboard'];

  it('is route-mode (not feature-registry) so the PM mounts features on real routes', () => {
    expect(dash.wiring).toBe('route');
    expect(dash.domain).toBe('dashboard');
  });

  it('declares a generic app-state testHarness (route / auth / last-mutation)', () => {
    expect(dash.testHarness?.globalKey).toBe('window.__harness');
    expect(dash.testHarness?.readySignal).toBe('ready');
    const shape = dash.testHarness?.snapshotShape ?? {};
    for (const key of [
      'snapshot.route',
      'snapshot.authStatus',
      'snapshot.lastMutation',
      'snapshot.ready',
    ]) {
      expect(shape[key]).toBeDefined();
    }
    expect(shape['snapshot.authStatus'].enum).toContain('authenticated');
  });

  it('ships the REAL seam module, PRODUCTION-ABSENT (env-guarded), not a game seam', () => {
    const seam = dash.augmentFiles?.find((f) => f.path === 'src/lib/app-harness.tsx');
    expect(seam?.content).toContain('AppHarnessProvider');
    expect(seam?.content).toContain('useAppHarness');
    expect(seam?.content).toContain('window.__harness');
    expect(seam?.content).toContain("process.env.NEXT_PUBLIC_TEST_HARNESS !== '1'");
    // Generic app-state, NOT game state.
    expect(seam?.content).toContain('recordMutation');
    expect(seam?.content).not.toContain('GameState');
    // Publish happens INSIDE the guard.
    const guardIdx = seam!.content.indexOf('NEXT_PUBLIC_TEST_HARNESS');
    const publishIdx = seam!.content.indexOf('.__harness =');
    expect(publishIdx).toBeGreaterThan(guardIdx);
  });

  it('SCAFFOLD.md is a route-based contract that pre-bakes the seam', () => {
    expect(dash.scaffoldContract).toMatch(/__harness/);
    expect(dash.scaffoldContract).toMatch(/PRE-BAKED|do NOT author/i);
    expect(dash.scaffoldContract).toMatch(/MULTI-ROUTE|src\/app\/<route>/);
    // augmentFiles[0] invariant: SCAFFOLD.md mirrors scaffoldContract.
    expect(dash.augmentFiles?.[0].path).toBe('SCAFFOLD.md');
    expect(dash.augmentFiles?.[0].content).toBe(dash.scaffoldContract);
  });

  it('schema.json matches testHarness.snapshotShape (no drift)', () => {
    const file = dash.augmentFiles?.find((f) => f.path === '__harness.schema.json');
    const schema = JSON.parse(file!.content) as {
      globalKey: string;
      snapshot: Record<string, { type: string; enum?: string[] }>;
    };
    const fromContract = Object.fromEntries(
      Object.entries(dash.testHarness!.snapshotShape).map(([k, v]) => [
        k.replace(/^snapshot\./, ''),
        v,
      ]),
    );
    expect(schema.snapshot).toEqual(fromContract);
  });
});
