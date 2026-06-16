import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildStoryContextPack,
  serializeStoryContextPack,
  parseKnowledgeIndex,
  STORY_CONTEXT_PACK_VERSION,
  DEFAULT_RUN_COMMAND,
} from '../story-context-pack.mjs';

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'story-ctx-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(
    join(dir, 'plan.md'),
    '# Brick Breaker plan\n\nMVP. Touch only `src/`.\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'knowledge', 'index.md'),
    [
      '# Knowledge Index',
      '',
      '## Code articles',
      '- code/main.js.md — Game loop + canvas bootstrap.',
      '- code/dino.js.md — Dino physics + sprite rendering.',
      '- code/obstacle.js.md — Cactus spawning and scrolling.',
      '',
      '## System articles',
      '- system/dependency-map.md — Module → module import graph.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'src', 'main.js'), `// main.js\nconst W = 800;\nconst H = 600;\n`, 'utf8');
  writeFileSync(join(dir, 'src', 'dino.js'), `export class Dino {}\n`, 'utf8');
  // Init a git repo so git log works
  execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=A commit -q -m "init"', {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return dir;
}

function sampleStory(overrides = {}) {
  return {
    storyId: 'S-CTX-1',
    title: 'Add ground line to canvas',
    description: 'Render a horizontal ground line at y = H - 40.',
    criteria: [
      { id: 'AC-1', text: 'Ground is visible at the bottom of the canvas.', needsBrowser: true },
      { id: 'AC-2', text: 'Ground colour matches palette.' },
    ],
    touchPoints: ['src/main.js'],
    hasBrowserTests: true,
    wave: 0,
    ...overrides,
  };
}

describe('buildStoryContextPack', () => {
  let dir;

  beforeEach(() => {
    dir = makeTmpProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a deterministic pack across two consecutive runs', async () => {
    const a = await buildStoryContextPack({
      plan: { name: 'brick', runCommand: 'npm run dev -- --port 5173' },
      story: sampleStory(),
      prevStoriesInWave: [],
      projectDir: dir,
      waveStartTime: '2026-01-01T00:00:00.000Z',
    });
    const b = await buildStoryContextPack({
      plan: { name: 'brick', runCommand: 'npm run dev -- --port 5173' },
      story: sampleStory(),
      prevStoriesInWave: [],
      projectDir: dir,
      waveStartTime: '2026-01-01T00:00:00.000Z',
    });
    expect(serializeStoryContextPack(a)).toBe(serializeStoryContextPack(b));
    expect(a.version).toBe(STORY_CONTEXT_PACK_VERSION);
  });

  it('reads plan.md, knowledge/index.md, and project tree from disk', async () => {
    const pack = await buildStoryContextPack({
      plan: { name: 'brick' },
      story: sampleStory(),
      projectDir: dir,
    });
    expect(pack.planMd).toContain('Brick Breaker plan');
    expect(pack.knowledgeIndex).toContain('code/main.js.md — Game loop');
    expect(pack.projectTree).toContain('src/');
    expect(pack.projectTree).toContain('main.js');
    // node_modules / knowledge / .git should never appear in the tree
    expect(pack.projectTree).not.toContain('node_modules');
    expect(pack.projectTree).not.toMatch(/^\.git/m);
  });

  it('digests every declared touch point with sha + head N lines', async () => {
    const pack = await buildStoryContextPack({
      story: sampleStory({ touchPoints: ['src/main.js', 'src/dino.js'] }),
      projectDir: dir,
    });
    expect(Object.keys(pack.fileDigests).sort()).toEqual([
      'src/dino.js',
      'src/main.js',
    ]);
    expect(pack.fileDigests['src/main.js'].sha).toMatch(/^[a-f0-9]{12}$/);
    expect(pack.fileDigests['src/main.js'].head).toContain('const W = 800');
    expect(pack.fileDigests['src/main.js'].lines).toBeGreaterThan(0);
  });

  it('records a missing touch-point file without throwing (story may create it)', async () => {
    const pack = await buildStoryContextPack({
      story: sampleStory({ touchPoints: ['src/does-not-exist-yet.js'] }),
      projectDir: dir,
    });
    expect(pack.fileDigests['src/does-not-exist-yet.js'].sha).toBe('missing');
    expect(pack.fileDigests['src/does-not-exist-yet.js'].head).toMatch(/not found/i);
  });

  it('ignores absolute-path or `..` touch points (defense against bad input)', async () => {
    const pack = await buildStoryContextPack({
      story: sampleStory({ touchPoints: ['/etc/passwd', '../escape.js', 'src/main.js'] }),
      projectDir: dir,
    });
    expect(Object.keys(pack.fileDigests)).toEqual(['src/main.js']);
  });

  it('falls back to DEFAULT_RUN_COMMAND when neither plan.runCommand nor opts.runCommandFallback is set', async () => {
    const pack = await buildStoryContextPack({
      plan: {},
      story: sampleStory(),
      projectDir: dir,
    });
    expect(pack.runCommand).toBe(DEFAULT_RUN_COMMAND);
  });

  it('caps prevWorkSummaries at 5 entries and emits a truncation warning', async () => {
    const seen = [];
    const prev = Array.from({ length: 8 }, (_, i) => ({
      storyId: `S-${i}`,
      title: `Story ${i}`,
      workSummary: `Did thing ${i}`,
    }));
    const pack = await buildStoryContextPack({
      story: sampleStory(),
      prevStoriesInWave: prev,
      projectDir: dir,
      onWarning: (e) => seen.push(e),
    });
    expect(pack.prevWorkSummaries).toHaveLength(5);
    expect(seen.some((e) => e.type === 'prev-summaries-truncated')).toBe(true);
  });

  it('truncates the longest digest when the pack would exceed the token budget', async () => {
    const big = 'x'.repeat(200_000);
    writeFileSync(join(dir, 'src', 'big.js'), big, 'utf8');
    const seen = [];
    const pack = await buildStoryContextPack({
      story: sampleStory({ touchPoints: ['src/big.js'] }),
      projectDir: dir,
      tokenBudget: 1000, // very small to force truncation
      onWarning: (e) => seen.push(e),
    });
    const serialized = serializeStoryContextPack(pack);
    // Either truncated head or dropped entirely; both warn.
    expect(seen.some((e) => e.type === 'context-truncated')).toBe(true);
    expect(serialized.length).toBeLessThanOrEqual(1000 * 4 + 1000);
  });

  it('throws on missing storyId or projectDir', async () => {
    await expect(
      buildStoryContextPack({ story: { title: 'no id' }, projectDir: dir }),
    ).rejects.toThrow(/storyId/);
    await expect(
      buildStoryContextPack({ story: sampleStory() }),
    ).rejects.toThrow(/projectDir/);
  });

  it('serialized output is byte-identical for the same inputs (cache stability)', async () => {
    const pack = await buildStoryContextPack({
      plan: { runCommand: 'npm run dev' },
      story: sampleStory(),
      prevStoriesInWave: [
        { storyId: 'S-PREV-1', title: 'Set up canvas', workSummary: 'Created index.html + main.js.' },
      ],
      projectDir: dir,
      waveStartTime: '2026-01-01T00:00:00.000Z',
    });
    const a = serializeStoryContextPack(pack);
    const b = serializeStoryContextPack(pack);
    expect(a).toBe(b);
    // No timestamp tokens that would break cache stability across runs
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('serialized output ends with a stable header layout', async () => {
    const pack = await buildStoryContextPack({
      story: sampleStory(),
      projectDir: dir,
    });
    const out = serializeStoryContextPack(pack);
    expect(out).toContain('<!-- story-context-pack v2 -->');
    expect(out).toContain('# Project context — story S-CTX-1');
    expect(out).toContain('## Run command');
    expect(out).toContain('## Story spec');
    expect(out).toContain('## Plan');
    expect(out).toContain('## Project tree');
    expect(out).toContain('## Adjacent files');
    expect(out).toContain('## Knowledge index');
    expect(out).toContain('## Recent diffs');
    expect(out).toContain('## Prior story work summaries');
  });

  // PR-51 — split touch-points into existing vs to-create sections.
  it('serializer splits existing files from pending-create files', async () => {
    const pack = await buildStoryContextPack({
      story: {
        ...sampleStory(),
        touchPoints: ['src/main.js', 'src/does-not-exist-yet.js'],
      },
      projectDir: dir,
    });
    const out = serializeStoryContextPack(pack);
    expect(out).toContain('## Adjacent files (existing on disk)');
    expect(out).toContain('## Adjacent files (to create — these do NOT exist yet)');
    // existing file is in the existing section
    const existingSectionStart = out.indexOf('## Adjacent files (existing on disk)');
    const pendingSectionStart = out.indexOf('## Adjacent files (to create');
    expect(out.slice(existingSectionStart, pendingSectionStart)).toContain('src/main.js');
    expect(out.slice(existingSectionStart, pendingSectionStart)).not.toContain(
      'src/does-not-exist-yet.js',
    );
    // pending file is in the pending section
    expect(out.slice(pendingSectionStart)).toContain('src/does-not-exist-yet.js');
    // pending section warns DEV not to Read these
    expect(out.slice(pendingSectionStart)).toMatch(/do NOT use the Read tool/i);
  });

  it('serializer omits the pending section when all touch-points exist', async () => {
    const pack = await buildStoryContextPack({
      story: { ...sampleStory(), touchPoints: ['src/main.js'] },
      projectDir: dir,
    });
    const out = serializeStoryContextPack(pack);
    expect(out).toContain('## Adjacent files (existing on disk)');
    expect(out).not.toContain('## Adjacent files (to create');
  });
});

describe('parseKnowledgeIndex', () => {
  it('parses "<path> — <purpose>" entries and ignores headings/blanks', () => {
    const md = [
      '# Knowledge Index',
      '',
      '## Code articles',
      '- code/main.js.md — Game loop',
      '- code/dino.js.md — Dino physics',
      '',
      '## System articles',
      '- system/dependency-map.md — Module graph',
    ].join('\n');
    const entries = parseKnowledgeIndex(md);
    expect(entries).toEqual([
      { path: 'code/main.js.md', purpose: 'Game loop' },
      { path: 'code/dino.js.md', purpose: 'Dino physics' },
      { path: 'system/dependency-map.md', purpose: 'Module graph' },
    ]);
  });

  it('keeps non-conforming lines as { raw }', () => {
    const md = '- code/legacy.js.md (no purpose annotation)\n';
    expect(parseKnowledgeIndex(md)).toEqual([
      { raw: 'code/legacy.js.md (no purpose annotation)' },
    ]);
  });

  it('returns [] on empty / non-string input', () => {
    expect(parseKnowledgeIndex('')).toEqual([]);
    expect(parseKnowledgeIndex(null)).toEqual([]);
    expect(parseKnowledgeIndex(undefined)).toEqual([]);
  });
});

/**
 * Concept v2 — Stories E3.2/E3.3/E3.4: the pack carries + renders the BMAD-grade
 * story fields, bumps the version, and stays byte-deterministic + back-compat.
 */
describe('Story Context Pack — BMAD-grade enrichment (Concept v2 E3.2–E3.4)', () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpProject();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function enrichedStory(overrides = {}) {
    return sampleStory({
      userStory: { role: 'player', action: 'see the score rise', benefit: 'feel progress' },
      technicalNotes: 'Reuse the existing canvas; do not add build config.',
      tasks: [
        { id: 'T1', text: 'Draw the score HUD', acRefs: ['AC-1'] },
        { id: 'T2', text: 'Increment on collision', acRefs: ['AC-1', 'AC-2'], done: true },
      ],
      criteria: [
        {
          id: 'AC-1',
          text: 'Score increments on collision.',
          needsBrowser: true,
          given: 'a game in playing state',
          when: 'the ball hits a paddle',
          then: 'the score increments by 1',
          verify: 'behavior',
        },
        {
          id: 'AC-2',
          text: 'Operator confirms the real payment.',
          verify: 'manual',
          manualReason: 'real-payment',
        },
      ],
      ...overrides,
    });
  }

  it('E3.4 — pack version is 2', async () => {
    expect(STORY_CONTEXT_PACK_VERSION).toBe(2);
    const pack = await buildStoryContextPack({ story: enrichedStory(), projectDir: dir });
    expect(pack.version).toBe(2);
  });

  it('E3.2/E3.3 — renders user-story, technical notes, BDD ACs (with verify tag) and tasks', async () => {
    const pack = await buildStoryContextPack({ story: enrichedStory(), projectDir: dir });
    const md = serializeStoryContextPack(pack);
    expect(md).toContain('_As a player, I want see the score rise, so that feel progress._');
    expect(md).toContain('### Technical notes');
    expect(md).toContain('Reuse the existing canvas');
    // BDD form + verify tag
    expect(md).toContain('[verify=behavior]');
    expect(md).toContain('- Given a game in playing state');
    expect(md).toContain('- When the ball hits a paddle');
    expect(md).toContain('- Then the score increments by 1');
    // manual carries its reason
    expect(md).toContain('[verify=manual:real-payment]');
    // tasks with acRefs + done box
    expect(md).toContain('### Tasks');
    expect(md).toContain('- [ ] T1: Draw the score HUD (AC-1)');
    expect(md).toContain('- [x] T2: Increment on collision (AC-1, AC-2)');
  });

  it('byte-deterministic across two runs with the enriched story', async () => {
    const a = await buildStoryContextPack({ story: enrichedStory(), projectDir: dir });
    const b = await buildStoryContextPack({ story: enrichedStory(), projectDir: dir });
    expect(serializeStoryContextPack(a)).toBe(serializeStoryContextPack(b));
  });

  it('back-compat — a legacy flat-text story still renders the `- AC: text` form, no BDD', async () => {
    const pack = await buildStoryContextPack({ story: sampleStory(), projectDir: dir });
    const md = serializeStoryContextPack(pack);
    expect(md).toContain('- AC-1: Ground is visible at the bottom of the canvas. [needs_browser=true]');
    expect(md).not.toContain('- Given ');
    expect(md).not.toContain('### Tasks');
    expect(md).not.toContain('_As a ');
  });

  it('E7.7 — inlines a cited artifact section from concept/<source>.md via its manifest', async () => {
    // Write an architecture artifact + its locked section manifest into the project.
    const conceptDir = join(dir, 'concept');
    mkdirSync(conceptDir, { recursive: true });
    const archMd = [
      '<!--§overview-->',
      '# Architecture',
      '',
      'Intro.',
      '',
      '<!--§state-model-->',
      '## State Model',
      '',
      'The store is a single reducer keyed by gameState.',
    ].join('\n');
    writeFileSync(join(conceptDir, 'architecture.md'), archMd, 'utf8');
    writeFileSync(
      join(conceptDir, 'architecture.sections.json'),
      JSON.stringify({
        artifact: 'architecture',
        rev: 1,
        contentHash: 'sha256:x',
        sections: [
          { id: 'overview', title: 'Architecture', lineStart: 1, lineEnd: 5 },
          { id: 'state-model', title: 'State Model', lineStart: 6, lineEnd: 9 },
        ],
      }),
      'utf8',
    );

    const pack = await buildStoryContextPack({
      story: enrichedStory({
        references: [{ source: 'architecture', section: 'state-model', note: 'state shape' }],
      }),
      projectDir: dir,
    });
    const md = serializeStoryContextPack(pack);
    expect(md).toContain('### Cited contract sections');
    expect(md).toContain('#### architecture › State Model');
    expect(md).toContain('The store is a single reducer keyed by gameState.');
    // Only the cited section is inlined, not the whole doc.
    expect(md).not.toContain('Intro.');
  });

  it('E7.7 — a reference to a missing artifact is skipped gracefully (gate enforces existence)', async () => {
    const pack = await buildStoryContextPack({
      story: enrichedStory({
        references: [{ source: 'architecture', section: 'state-model' }],
      }),
      projectDir: dir, // no concept/ dir written
    });
    expect(pack.citedSections).toEqual([]);
    expect(serializeStoryContextPack(pack)).not.toContain('### Cited contract sections');
  });

  it('E4.3 — a story-spec floor that busts the budget emits references-over-budget (not silent truncation)', async () => {
    const seen = [];
    // A huge technical-notes block makes the non-trimmable story-spec floor
    // alone exceed a tiny budget — there are no digests left to drop.
    const huge = 'x'.repeat(80_000);
    await buildStoryContextPack({
      story: enrichedStory({ technicalNotes: huge, touchPoints: [] }),
      projectDir: dir,
      tokenBudget: 500,
      onWarning: (e) => seen.push(e),
    });
    expect(seen.some((e) => e.type === 'references-over-budget')).toBe(true);
  });
});
