import { describe, it, expect } from 'vitest';
import {
  BOILERPLATE_REGISTRY,
  getBoilerplateMetadata,
  getWiredBoilerplateTypes,
} from '../registry';
import type { BoilerplateType } from '../registry';

// All members of the union, kept in sync manually. If you add a new
// BoilerplateType and forget to add it here the tests below will catch it.
const ALL_TYPES: BoilerplateType[] = ['nextjs', 'sst', 'vite', 'mobile'];

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
    const meta = getBoilerplateMetadata('nextjs');
    expect(meta.type).toBe('nextjs');
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
  it('returns exactly ["nextjs"] in Phase 1', () => {
    const wired = getWiredBoilerplateTypes();
    expect(wired).toEqual(['nextjs']);
  });

  it('returns only types whose status is wired', () => {
    const wired = getWiredBoilerplateTypes();
    for (const type of wired) {
      expect(BOILERPLATE_REGISTRY[type].status).toBe('wired');
    }
  });
});

describe('nextjs registry entry — spot-check AC values', () => {
  const meta = BOILERPLATE_REGISTRY['nextjs'];

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

describe('stub types — spot-check', () => {
  it.each(['sst', 'vite', 'mobile'] as BoilerplateType[])(
    '%s has status stub and bmadSupported=false',
    (type) => {
      const meta = BOILERPLATE_REGISTRY[type];
      expect(meta.status).toBe('stub');
      expect(meta.bmadSupported).toBe(false);
    },
  );

  it('mobile uses react-native runtime and expo commands', () => {
    const meta = BOILERPLATE_REGISTRY['mobile'];
    expect(meta.defaultStack.runtime).toBe('react-native');
    expect(meta.defaultStack.devCommand).toBe('npx expo start');
    expect(meta.defaultStack.buildCommand).toBe('npx expo build');
  });
});
