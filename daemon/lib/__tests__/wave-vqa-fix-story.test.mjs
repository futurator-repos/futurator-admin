/**
 * Tests for the v2.6 M5 fix-story builder — the wave gate's fix-forward →
 * auto-minted story path. Pins: grouping by owning story, wave placement at
 * max+1, dependsOn/criteria/touchPoints derivation, the ONE-per-owner cap
 * (recurrence escalates instead of minting), and the handoff markdown that
 * becomes the DEV agent's instructions.
 */

import { describe, expect, it } from 'vitest';
import { buildVqaFixStories, renderHandoffMarkdown } from '../wave-vqa-fix-story.mjs';

const handoff = (acId, storyId, extra = {}) => ({
  storyId,
  storyTitle: 'Owner story',
  acId,
  acText: `criterion ${acId}`,
  verdicts: [{ lens: 'strict', verdict: 'FAIL', confidence: 'high', observation: 'absent' }],
  evidence: { screenshotUrl: 'https://e/x.png', capturedSurface: 'the isolated surface' },
  triage: { classification: 'code-bug', suspectedFiles: ['src/features/x.feature.tsx'], summary: 'not mounted' },
  attempts: [{ round: 1, fixer: 'tried', result: 'still-failing' }],
  expected: `criterion ${acId}`,
  observed: 'absent',
  verifyCommand: 'boot; screenshot ?feature=x; criterion must hold',
  ...extra,
});

const owner = { storyId: 'S1', title: 'Render the surface', wave: 2, touchPoints: ['src/game/a.ts'] };

let n = 0;
const uuid = () => `fix-${++n}`;

describe('buildVqaFixStories', () => {
  it('mints ONE story per owning story at wave max+1, carrying the handoffs', () => {
    const { minted, escalations } = buildVqaFixStories({
      existingStories: [owner, { storyId: 'S2', wave: 3 }],
      fixForward: [handoff('AC-1', 'S1'), handoff('AC-2', 'S1')],
      waveNumber: 2,
      uuid,
    });
    expect(escalations).toHaveLength(0);
    expect(minted).toHaveLength(1);
    const s = minted[0];
    expect(s.wave).toBe(4); // max wave (3) + 1
    expect(s.dependsOn).toEqual(['S1']);
    expect(s.origin).toBe('wave-vqa-fix');
    expect(s.status).toBe('pending');
    expect(s.hasBrowserTests).toBe(true);
    expect(s.criteria).toEqual([
      { id: 'AC-1', text: 'criterion AC-1', needsBrowser: true },
      { id: 'AC-2', text: 'criterion AC-2', needsBrowser: true },
    ]);
    // Touch points from triage's suspected files (deduped).
    expect(s.touchPoints).toEqual(['src/features/x.feature.tsx']);
    expect(s.title).toContain('AC-1, AC-2');
    expect(s.title).toContain('Render the surface');
    // The description IS the handoff — the DEV agent's instructions.
    expect(s.description).toContain('## AC-1: criterion AC-1');
    expect(s.description).toContain('- Observed: absent');
    expect(s.description).toContain('.context/vqa-handoffs');
    expect(s.description).toContain('round 1 → still-failing');
    // P3 (pong1) — provenance of the FAILING wave (≠ minted wave − 1 here:
    // minted at max+1=4 while the failure was confirmed at wave 2). The
    // daemon rebuilds the originating card's dedupKey from this to
    // auto-resolve wave-vqa-failed when the fix story verifies.
    expect(s.fixesWave).toBe(2);
  });

  it('falls back to the owner touchPoints when triage named no files', () => {
    const { minted } = buildVqaFixStories({
      existingStories: [owner],
      fixForward: [handoff('AC-1', 'S1', { triage: null })],
      waveNumber: 2,
      uuid,
    });
    expect(minted[0].touchPoints).toEqual(['src/game/a.ts']);
  });

  it('CAP: a second failure for the same owner escalates instead of minting', () => {
    const priorFix = {
      storyId: 'old-fix',
      wave: 3,
      origin: 'wave-vqa-fix',
      dependsOn: ['S1'],
    };
    const { minted, escalations } = buildVqaFixStories({
      existingStories: [owner, priorFix],
      fixForward: [handoff('AC-1', 'S1')],
      waveNumber: 3,
      uuid,
    });
    expect(minted).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].ownerId).toBe('S1');
  });

  it('groups failures by owner: two owners → two stories, both at the same new wave', () => {
    const { minted } = buildVqaFixStories({
      existingStories: [owner, { storyId: 'S2', title: 'Other', wave: 2, touchPoints: [] }],
      fixForward: [handoff('AC-1', 'S1'), handoff('AC-9', 'S2')],
      waveNumber: 2,
      uuid,
    });
    expect(minted).toHaveLength(2);
    expect(new Set(minted.map((s) => s.wave))).toEqual(new Set([3]));
    expect(minted.map((s) => s.dependsOn[0]).sort()).toEqual(['S1', 'S2']);
  });
});

describe('renderHandoffMarkdown', () => {
  it('renders every load-bearing handoff field', () => {
    const md = renderHandoffMarkdown({ handoffs: [handoff('AC-1', 'S1')], waveNumber: 5 });
    expect(md).toContain('wave 5 VQA gate (fix-forward)');
    expect(md).toContain('- Expected: criterion AC-1');
    expect(md).toContain('- Captured surface: the isolated surface');
    expect(md).toContain('- Screenshot: https://e/x.png');
    expect(md).toContain('- Triage: not mounted');
    expect(md).toContain('- Suspected files: src/features/x.feature.tsx');
    expect(md).toContain('- Verify: boot; screenshot ?feature=x');
  });
});
