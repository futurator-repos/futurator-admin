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
    expect(injectStep?.targetFiles).toEqual(['package.json', 'README.md', 'CLAUDE.md']);
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
