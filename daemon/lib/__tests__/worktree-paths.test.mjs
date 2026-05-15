/**
 * worktree-paths.test.mjs — Pipeline v2 Phase 2-B / Story 2-B-2-1 (PR-86).
 */

import { describe, it, expect } from 'vitest';
import {
  storyWorktreeDir,
  exploreWorktreeDir,
  storyBranchName,
  exploreBranchName,
  archiveBranchName,
  streamBranchName,
  experimentBranchName,
  hotfixBranchName,
  ensureUnderRoot,
} from '../worktree-paths.mjs';

describe('storyWorktreeDir', () => {
  it('builds canonical path', () => {
    expect(
      storyWorktreeDir({
        project: 'songster',
        plan: 'songster-v2-storyboard',
        storyId: 'e3-s5',
        root: '/wt',
      }),
    ).toBe('/wt/songster/songster-v2-storyboard/e3-s5');
  });

  it('rejects malformed slugs', () => {
    expect(() =>
      storyWorktreeDir({ project: 'BAD', plan: 'p', storyId: 's1', root: '/wt' }),
    ).toThrow();
    expect(() =>
      storyWorktreeDir({ project: 'p', plan: 'has spaces', storyId: 's1', root: '/wt' }),
    ).toThrow();
    expect(() =>
      storyWorktreeDir({ project: 'p', plan: 'p', storyId: '..', root: '/wt' }),
    ).toThrow();
  });
});

describe('exploreWorktreeDir', () => {
  it('builds explore-<approach> path', () => {
    expect(
      exploreWorktreeDir({
        project: 'songster',
        plan: 'songster-v2-billing',
        approach: 'hosted-checkout',
        root: '/wt',
      }),
    ).toBe('/wt/songster/songster-v2-billing/explore-hosted-checkout');
  });
});

describe('branch name helpers', () => {
  it('storyBranchName uses wip/ prefix', () => {
    expect(storyBranchName('e3-s5')).toBe('wip/e3-s5');
  });

  it('exploreBranchName combines plan + approach', () => {
    expect(
      exploreBranchName({ planId: 'songster-v2-billing', approach: 'hosted-checkout' }),
    ).toBe('explore/songster-v2-billing-hosted-checkout');
  });

  it('archiveBranchName uses archive/ prefix + -rejected suffix', () => {
    expect(
      archiveBranchName({ planId: 'songster-v2-billing', approach: 'embedded-elements' }),
    ).toBe('archive/songster-v2-billing-embedded-elements-rejected');
  });

  it('streamBranchName uses stream/ prefix', () => {
    expect(streamBranchName('live-perf-teleprompter')).toBe(
      'stream/live-perf-teleprompter',
    );
  });

  it('experimentBranchName uses experiment/ prefix', () => {
    expect(experimentBranchName('new-renderer')).toBe('experiment/new-renderer');
  });

  it('hotfixBranchName accepts semver tags', () => {
    expect(hotfixBranchName('songster-v2.4.1')).toBe('hotfix/songster-v2.4.1');
    expect(hotfixBranchName('v1.0.0')).toBe('hotfix/v1.0.0');
  });

  it('hotfix rejects path-traversal', () => {
    expect(() => hotfixBranchName('../sneaky')).toThrow();
    expect(() => hotfixBranchName('with/slash')).toThrow();
    expect(() => hotfixBranchName('')).toThrow();
  });

  it('rejects malformed branch slugs', () => {
    expect(() => storyBranchName('Bad-Case')).toThrow();
    expect(() => streamBranchName('a/b')).toThrow();
    expect(() => experimentBranchName('')).toThrow();
  });
});

describe('ensureUnderRoot', () => {
  it('accepts paths under root', () => {
    expect(ensureUnderRoot('/wt/foo/bar', '/wt')).toBe('/wt/foo/bar');
  });

  it('rejects ..', () => {
    expect(() => ensureUnderRoot('/wt/foo/../escape', '/wt')).toThrow(/\.\./);
  });

  it('rejects paths outside root', () => {
    expect(() => ensureUnderRoot('/etc/passwd', '/wt')).toThrow(/not under root/);
  });
});
