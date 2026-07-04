import { describe, it, expect } from 'vitest';
import { matchesDenyPattern } from '../bash-deny-patterns.mjs';

describe('matchesDenyPattern — B8 runtime tool enforcement', () => {
  it('returns denied=false on empty/non-string input', () => {
    expect(matchesDenyPattern('').denied).toBe(false);
    expect(matchesDenyPattern(null).denied).toBe(false);
    expect(matchesDenyPattern(undefined).denied).toBe(false);
    expect(matchesDenyPattern(42).denied).toBe(false);
  });

  describe('scaffolding commands', () => {
    it('blocks `npm create vite`', () => {
      const r = matchesDenyPattern('npm create vite my-app');
      expect(r.denied).toBe(true);
      expect(r.label).toBe('scaffold-vite');
    });

    it('blocks `npx create-vite`', () => {
      expect(matchesDenyPattern('npx create-vite').denied).toBe(true);
    });

    it('blocks `create-next-app`', () => {
      const r = matchesDenyPattern('npx create-next-app .');
      expect(r.denied).toBe(true);
      expect(r.label).toBe('scaffold-next');
    });

    it('blocks `create-react-app`', () => {
      expect(matchesDenyPattern('npx create-react-app foo').denied).toBe(true);
    });

    it('blocks BMAD init', () => {
      expect(matchesDenyPattern('npx bmad-method install').denied).toBe(true);
      expect(matchesDenyPattern('bmad-method init').denied).toBe(true);
    });

    it('blocks `tsc --init`', () => {
      expect(matchesDenyPattern('npx tsc --init').denied).toBe(true);
      expect(matchesDenyPattern('tsc --init').denied).toBe(true);
    });

    it('blocks `git init`', () => {
      expect(matchesDenyPattern('git init').denied).toBe(true);
      expect(matchesDenyPattern('cd /tmp && git init').denied).toBe(true);
    });
  });

  describe('destructive deletion commands', () => {
    it('blocks `rm -rf .`', () => {
      const r = matchesDenyPattern('rm -rf .');
      expect(r.denied).toBe(true);
      expect(r.label).toBe('rm-rf-project-root');
    });

    it('blocks `rm -rf ./`', () => {
      expect(matchesDenyPattern('rm -rf ./').denied).toBe(true);
    });

    it('blocks `rm -rf ./*`', () => {
      expect(matchesDenyPattern('rm -rf ./*').denied).toBe(true);
    });

    it('blocks `rm -rf package.json`', () => {
      const r = matchesDenyPattern('rm -rf package.json');
      expect(r.denied).toBe(true);
      expect(r.label).toBe('rm-rf-essentials');
    });

    it('blocks `rm -rf node_modules`', () => {
      expect(matchesDenyPattern('rm -rf node_modules').denied).toBe(true);
    });

    it('blocks `rm -rf src`', () => {
      expect(matchesDenyPattern('rm -rf src').denied).toBe(true);
    });

    it('blocks `rm -rf .git`', () => {
      expect(matchesDenyPattern('rm -rf .git').denied).toBe(true);
    });

    it('blocks `rm -rf _bmad`', () => {
      expect(matchesDenyPattern('rm -rf _bmad').denied).toBe(true);
    });

    it('handles -Rf and -fr flag variants', () => {
      expect(matchesDenyPattern('rm -Rf node_modules').denied).toBe(true);
      expect(matchesDenyPattern('rm -fr node_modules').denied).toBe(true);
    });
  });

  describe('safe commands that should NOT be blocked', () => {
    it('allows `npm install` (no-arg refresh)', () => {
      expect(matchesDenyPattern('npm install').denied).toBe(false);
    });

    it('allows `npm install <package>`', () => {
      expect(matchesDenyPattern('npm install lodash').denied).toBe(false);
    });

    it('allows `npm test`', () => {
      expect(matchesDenyPattern('npm test').denied).toBe(false);
    });

    it('allows `npm run build`', () => {
      expect(matchesDenyPattern('npm run build').denied).toBe(false);
    });

    it('allows `git diff`', () => {
      expect(matchesDenyPattern('git diff HEAD~1 HEAD').denied).toBe(false);
    });

    it('allows `git status`', () => {
      expect(matchesDenyPattern('git status -s').denied).toBe(false);
    });

    it('allows `git commit`', () => {
      expect(matchesDenyPattern('git commit -m "fix"').denied).toBe(false);
    });

    it('allows `rm <single-file>` (not -rf)', () => {
      expect(matchesDenyPattern('rm tmp.txt').denied).toBe(false);
    });

    it('allows `rm -f <single-file>`', () => {
      expect(matchesDenyPattern('rm -f tmp.txt').denied).toBe(false);
    });

    it('allows `rm -rf <subdir>` that is not a project essential', () => {
      // Removing dist/ or build/ is fine (caches/artifacts).
      expect(matchesDenyPattern('rm -rf dist').denied).toBe(false);
      expect(matchesDenyPattern('rm -rf build').denied).toBe(false);
      expect(matchesDenyPattern('rm -rf .next').denied).toBe(false);
    });

    it('allows `tsc --noEmit`', () => {
      expect(matchesDenyPattern('npx tsc --noEmit').denied).toBe(false);
      expect(matchesDenyPattern('tsc --noEmit').denied).toBe(false);
    });

    it('allows `vite build`', () => {
      expect(matchesDenyPattern('vite build').denied).toBe(false);
      expect(matchesDenyPattern('npx vite build').denied).toBe(false);
    });
  });

  describe('compound shell shapes', () => {
    it('blocks scaffolding commands chained with &&', () => {
      const r = matchesDenyPattern('cd /tmp && npm create vite');
      expect(r.denied).toBe(true);
    });

    it('blocks scaffolding commands chained with ;', () => {
      expect(matchesDenyPattern('echo hi; npm create vite').denied).toBe(true);
    });

    it('blocks scaffolding commands chained with ||', () => {
      expect(matchesDenyPattern('false || npx create-next-app .').denied).toBe(true);
    });
  });

  it('attaches a human-readable reason to every deny', () => {
    const r = matchesDenyPattern('rm -rf node_modules');
    expect(r.reason).toBeTruthy();
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(10);
  });
});

describe('git-stash-shared-tree (pacman4 forensic)', () => {
  it('denies git stash / stash pop on the shared worktree', () => {
    expect(matchesDenyPattern('git stash && npx tsc --noEmit; git stash pop')?.label).toBe('git-stash-shared-tree');
    expect(matchesDenyPattern('cd /w && git stash pop')?.label).toBe('git-stash-shared-tree');
  });
  it('allows read-only stash inspection + unrelated git', () => {
    expect(matchesDenyPattern('git stash list').denied).toBe(false);
    expect(matchesDenyPattern('git stash show -p').denied).toBe(false);
    expect(matchesDenyPattern('git status --porcelain').denied).toBe(false);
  });
});
