import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectCustomAgents, parseCsv } from '../lib/inject-custom-agents.mjs';

let sourceDir;
let manifestPath;

const STOCK_MANIFEST =
  'name,displayName,title,icon,role,identity,communicationStyle,principles,module,path\n' +
  '"analyst","Mary","Business Analyst","📊","BA","senior","analytical","precision","bmm","bmad/bmm/agents/analyst.md"\n' +
  '"architect","Winston","Architect","🏗️","Architect","senior","pragmatic","scale","bmm","bmad/bmm/agents/architect.md"\n';

const RICK_MD = `---
name: 'rick-innovation'
description: 'Innovation Disruptor'
---

\`\`\`xml
<agent id="bmad/agents/rick-innovation/rick-innovation.md" name="Rick" title="Innovation Disruptor" icon="🧪">
  <persona>
    <role>Cross-domain Innovation Disruptor</role>
    <identity>Rick is the agent you consult when you suspect you are
    solving the wrong problem.</identity>
    <communication_style>Irreverent, fast-talking, casually brilliant.</communication_style>
    <principles>The best architecture is the one you delete.
You are solving the wrong problem. I guarantee it.</principles>
  </persona>
</agent>
\`\`\`
`;

const SUE_MD = `<agent id="bmad/agents/sue-render/sue-render.md" name="Sue Render" title="Animation Architect" icon="⚡">
<persona>
<role>Senior Animation Engineer</role>
<identity>Sees the world through the lens of things that move beautifully.</identity>
<communication_style>Sharp, elegant, technically precise.</communication_style>
<principles>60fps or bust.</principles>
</persona>
</agent>`;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'inject-custom-agents-'));
  sourceDir = join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });

  // Two agents in source
  mkdirSync(join(sourceDir, 'rick-innovation'), { recursive: true });
  writeFileSync(join(sourceDir, 'rick-innovation', 'rick-innovation.md'), RICK_MD);
  mkdirSync(join(sourceDir, 'sue-render'), { recursive: true });
  writeFileSync(join(sourceDir, 'sue-render', 'sue-render.md'), SUE_MD);

  // A stray subdir with no .md file — should be skipped silently
  mkdirSync(join(sourceDir, 'incomplete'), { recursive: true });

  manifestPath = join(root, '_bmad', '_config', 'agent-manifest.csv');
  mkdirSync(join(root, '_bmad', '_config'), { recursive: true });
  writeFileSync(manifestPath, STOCK_MANIFEST);
});

afterEach(() => {
  rmSync(sourceDir.replace(/\/source$/, ''), { recursive: true, force: true });
});

describe('injectCustomAgents', () => {
  it('appends custom-agent rows to a stock manifest', async () => {
    const result = await injectCustomAgents({ sourceDir, manifestPath });
    expect(result.injected).toBe(2);
    expect(result.total).toBe(4); // 2 stock + 2 custom

    const { rows } = parseCsv(readFileSync(manifestPath, 'utf8'));
    const slugs = rows.map((r) => r.name).sort();
    expect(slugs).toEqual(['analyst', 'architect', 'rick-innovation', 'sue-render']);

    const rick = rows.find((r) => r.name === 'rick-innovation');
    expect(rick).toBeDefined();
    expect(rick.displayName).toBe('Rick');
    expect(rick.title).toBe('Innovation Disruptor');
    expect(rick.icon).toBe('🧪');
    expect(rick.module).toBe('agents');
    expect(rick.path).toBe('_bmad/agents-custom/rick-innovation');
    // Multi-line principles should be flattened to one line
    expect(rick.principles).toBe(
      'The best architecture is the one you delete. You are solving the wrong problem. I guarantee it.',
    );
  });

  it('is idempotent — a second run does not duplicate rows', async () => {
    await injectCustomAgents({ sourceDir, manifestPath });
    const afterFirst = parseCsv(readFileSync(manifestPath, 'utf8')).rows.length;

    const result2 = await injectCustomAgents({ sourceDir, manifestPath });
    expect(result2.injected).toBe(2);

    const afterSecond = parseCsv(readFileSync(manifestPath, 'utf8')).rows.length;
    expect(afterSecond).toBe(afterFirst);
  });

  it('replaces existing custom rows rather than appending duplicates', async () => {
    // Simulate a manifest that already has a stale rick row
    const stale =
      STOCK_MANIFEST +
      '"rick-innovation","Old Rick","Old Title","🦖","old","old","old","old","agents","old/path"\n';
    writeFileSync(manifestPath, stale);

    await injectCustomAgents({ sourceDir, manifestPath });
    const { rows } = parseCsv(readFileSync(manifestPath, 'utf8'));
    const ricks = rows.filter((r) => r.name === 'rick-innovation');
    expect(ricks).toHaveLength(1);
    expect(ricks[0].displayName).toBe('Rick');
    expect(ricks[0].title).toBe('Innovation Disruptor');
  });

  it('skips gracefully when source dir does not exist', async () => {
    const result = await injectCustomAgents({
      sourceDir: '/tmp/does-not-exist-party-12345',
      manifestPath,
    });
    expect(result.injected).toBe(0);
    const { rows } = parseCsv(readFileSync(manifestPath, 'utf8'));
    expect(rows).toHaveLength(2); // only the stock rows
  });

  it('throws if manifest file does not exist', async () => {
    const missing = manifestPath + '.missing';
    await expect(
      injectCustomAgents({ sourceDir, manifestPath: missing }),
    ).rejects.toThrow(/manifest not found/);
  });

  it('captures onOutput events per injected agent', async () => {
    const outputs = [];
    await injectCustomAgents({
      sourceDir,
      manifestPath,
      onOutput: (o) => outputs.push(o),
    });
    const joined = outputs.map((o) => o.data).join('\n');
    expect(joined).toContain('injected rick-innovation');
    expect(joined).toContain('injected sue-render');
  });
});
