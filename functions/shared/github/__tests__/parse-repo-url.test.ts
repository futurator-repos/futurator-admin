import { describe, it, expect } from 'vitest';
import { parseGithubRepoUrl, resolveRepoRef, DEFAULT_GITHUB_OWNER } from '../parse-repo-url';

describe('parseGithubRepoUrl', () => {
  it('parses https URLs with and without .git', () => {
    expect(parseGithubRepoUrl('https://github.com/Get-Really-Real/applicator.git')).toEqual({
      owner: 'Get-Really-Real',
      repo: 'applicator',
    });
    expect(parseGithubRepoUrl('https://github.com/futurator-repos/dino1')).toEqual({
      owner: 'futurator-repos',
      repo: 'dino1',
    });
  });
  it('parses trailing-slash + ssh forms', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/widget/')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
    expect(parseGithubRepoUrl('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });
  it('returns null for empty/garbage', () => {
    expect(parseGithubRepoUrl('')).toBeNull();
    expect(parseGithubRepoUrl(null)).toBeNull();
    expect(parseGithubRepoUrl('not a url')).toBeNull();
  });
});

describe('resolveRepoRef', () => {
  it('prefers the explicit brownfield URL (any org)', () => {
    expect(
      resolveRepoRef('applicator', 'https://github.com/Get-Really-Real/applicator.git'),
    ).toEqual({ owner: 'Get-Really-Real', repo: 'applicator' });
  });
  it('falls back to futurator-repos/<appId> for greenfield', () => {
    expect(resolveRepoRef('dino1', null)).toEqual({ owner: DEFAULT_GITHUB_OWNER, repo: 'dino1' });
    expect(resolveRepoRef('dino1', undefined)).toEqual({ owner: 'futurator-repos', repo: 'dino1' });
  });
});
