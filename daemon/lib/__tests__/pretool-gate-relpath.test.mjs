import { describe, it, expect } from 'vitest';
import { toRepoRelative, decide } from '../pretool-gate.mjs';

describe('toRepoRelative (pacman2 canary fix)', () => {
  const roots = ['/home/ubuntu/projects/pacman2-1460c1', '/other/root'];
  it('strips the matching repo root', () => {
    expect(toRepoRelative('/home/ubuntu/projects/pacman2-1460c1/src/game/types.ts', roots))
      .toBe('src/game/types.ts');
  });
  it('leaves already-relative paths alone', () => {
    expect(toRepoRelative('src/game/types.ts', roots)).toBe('src/game/types.ts');
  });
  it('leaves paths outside every root absolute (forbidden checks still apply)', () => {
    expect(toRepoRelative('/etc/passwd', roots)).toBe('/etc/passwd');
  });
  it('tolerates trailing slash on the root + empty roots', () => {
    expect(toRepoRelative('/r/a/b.ts', ['/r/'])).toBe('a/b.ts');
    expect(toRepoRelative('/r/a/b.ts', [undefined, ''])).toBe('/r/a/b.ts');
  });
});

describe('decide with relativized path (the real pacman2 case)', () => {
  const policy = { touchPoints: ['src/game/types.ts', 'src/game/constants.ts', 'src/game/maze.ts'], forbiddenAreas: [] };
  it('ALLOWS an in-scope file once relativized (was a phantom block)', () => {
    const rel = toRepoRelative('/home/ubuntu/projects/pacman2-1460c1/src/game/types.ts', ['/home/ubuntu/projects/pacman2-1460c1']);
    const d = decide({ toolName: 'Edit', toolInput: { file_path: rel } }, policy);
    expect(d.decision).not.toBe('block');
  });
  it('still blocks a genuinely out-of-scope file', () => {
    const d = decide({ toolName: 'Edit', toolInput: { file_path: 'src/other/hack.ts' } }, policy);
    expect(d.decision).toBe('block');
  });
});
