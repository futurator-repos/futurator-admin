import { describe, it, expect } from 'vitest';
import { isSeamMounted, checkSeamMounted } from '../seam-mount-check.mjs';

describe('isSeamMounted — false-pass-proof two-stage logic', () => {
  it('mounted when a NON-definition file references the hook', () => {
    const r = isSeamMounted(
      ['src/game/types.ts', 'src/features/PacmanGame.tsx'],
      ['src/game/types.ts'], // the scaffold defines it here
    );
    expect(r.mounted).toBe(true);
    expect(r.importers).toEqual(['src/features/PacmanGame.tsx']);
  });

  it('NOT mounted when ONLY the definition file references it (the pacman4 false-pass)', () => {
    const r = isSeamMounted(['src/game/types.ts'], ['src/game/types.ts']);
    expect(r.mounted).toBe(false);
    expect(r.importers).toEqual([]);
  });

  it('NOT mounted when nothing references it', () => {
    const r = isSeamMounted([], []);
    expect(r.mounted).toBe(false);
  });
});

describe('checkSeamMounted — with injected exec', () => {
  const execFor = (refFiles, defFiles) => (cmd) => {
    if (/export \(function\|const\)/.test(cmd)) return defFiles.join('\n');
    if (/grep -rlE/.test(cmd)) return refFiles.join('\n');
    return '';
  };

  it('N/A (checked:false, never blocks) when the boilerplate has no seam hook', () => {
    const r = checkSeamMounted({ projectDir: '/x', seamHook: undefined, exec: () => '' });
    expect(r.checked).toBe(false);
    expect(r.mounted).toBe(true); // not a block
  });

  it('blocks (mounted:false) when only the scaffold defines the hook', () => {
    const r = checkSeamMounted({
      projectDir: '/x',
      seamHook: 'useGameStateMachine',
      exec: execFor(['src/game/useGameStateMachine.ts'], ['src/game/useGameStateMachine.ts']),
    });
    expect(r.checked).toBe(true);
    expect(r.mounted).toBe(false);
    expect(r.reason).toMatch(/not wired|never imported|static preview/i);
  });

  it('blocks when NOTHING references the hook', () => {
    const r = checkSeamMounted({
      projectDir: '/x',
      seamHook: 'useGameStateMachine',
      exec: execFor([], []),
    });
    expect(r.mounted).toBe(false);
    expect(r.reason).toMatch(/no source file references/i);
  });

  it('passes when a feature imports the hook', () => {
    const r = checkSeamMounted({
      projectDir: '/x',
      seamHook: 'useGameStateMachine',
      exec: execFor(
        ['src/game/useGameStateMachine.ts', 'src/features/PacmanGame.tsx'],
        ['src/game/useGameStateMachine.ts'],
      ),
    });
    expect(r.mounted).toBe(true);
    expect(r.importers).toEqual(['src/features/PacmanGame.tsx']);
  });

  it('respects the dashboard hook (useAppHarness), not a hardcoded game hook', () => {
    const r = checkSeamMounted({
      projectDir: '/x',
      seamHook: 'useAppHarness',
      exec: execFor(['src/app/harness.ts', 'src/routes/Dashboard.tsx'], ['src/app/harness.ts']),
    });
    expect(r.mounted).toBe(true);
  });
});
