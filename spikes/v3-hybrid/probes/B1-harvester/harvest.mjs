#!/usr/bin/env node
/**
 * B1 — telemetry harvester (spike test plan §2).
 *
 * Tests O4 / O3: can the scorecard's per-step telemetry (model, tokens,
 * duration) be reconstructed for a v3 workflow run, given that the workflow's
 * RETURNED report omits it and the only copy lives in undocumented per-agent
 * transcripts under  <session>/subagents/workflows/<runId>/ ?
 *
 * Usage:  node harvest.mjs <spike-WORK-dir> [--json]
 *   e.g.  node harvest.mjs /tmp/v3-spike-clean-run
 *
 * What it does:
 *   1. munge the WORK dir → the ~/.claude/projects/<proj> transcript dir
 *   2. find every  subagents/workflows/wf_* run dir
 *   3. journal.jsonl   → agentId → structured result (the story it produced)
 *   4. agent-*.jsonl   → model, summed input/output tokens, durationMs (last-first ts)
 *   5. emit AgentEvent-shaped rows + a reconciliation block
 *
 * Falsification (FH): if a workflow agent cannot be mapped back to a story id,
 * or durationMs cannot be derived, §12 scorecard-continuity is unachievable
 * without an Anthropic runtime change → S0 is blocked. The harvester REPORTS
 * which of those facts it could and could not recover, honestly.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const work = process.argv[2]
const jsonMode = process.argv.includes('--json')
if (!work) {
  console.error('usage: harvest.mjs <spike-WORK-dir> [--json]')
  process.exit(2)
}

// 1. WORK dir → project transcript dir (Claude Code munges / and . to -)
const real = work.startsWith('/tmp/') ? `/private${work}` : work
const proj = join(homedir(), '.claude', 'projects', real.replace(/[/.]/g, '-'))
if (!existsSync(proj)) {
  console.error(`no transcript dir for ${work}\n  looked at: ${proj}`)
  process.exit(1)
}

const readJsonl = (p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

// 2. find every workflow run dir
const runDirs = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (!e.isDirectory()) continue
    if (e.name.startsWith('wf_') && existsSync(join(p, 'journal.jsonl'))) runDirs.push(p)
    else walk(p)
  }
}
walk(proj)

const rows = []
const recon = []
for (const dir of runDirs) {
  const runId = basename(dir)
  // 3. journal → agentId → result (story)
  const journal = readJsonl(join(dir, 'journal.jsonl'))
  const resultByAgent = {}
  const keyByAgent = {}
  for (const j of journal) {
    if (j.agentId) keyByAgent[j.agentId] = j.key
    if (j.type === 'result' && j.agentId) resultByAgent[j.agentId] = j.result
  }
  // 4. per-agent transcript → model, tokens, duration
  const agentFiles = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f))
  let runIn = 0,
    runOut = 0
  for (const af of agentFiles) {
    const agentId = af.replace(/^agent-/, '').replace(/\.jsonl$/, '')
    const t = readJsonl(join(dir, af))
    let model = null,
      inTok = 0,
      outTok = 0
    const ts = []
    for (const m of t) {
      if (m.timestamp) ts.push(Date.parse(m.timestamp))
      const u = m.message?.usage || m.usage
      if (u) {
        inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        outTok += u.output_tokens || 0
      }
      if (m.message?.model) model = m.message.model
    }
    ts.sort((a, b) => a - b)
    const durationMs = ts.length >= 2 ? ts[ts.length - 1] - ts[0] : null
    const result = resultByAgent[agentId]
    // O4 crux: map content-hash key → story. The ONLY bridge available without a
    // runtime change is the structured result the agent returned (.story).
    const story = result?.story ?? null
    runIn += inTok
    runOut += outTok
    rows.push({
      runId,
      agentId,
      story, // null = FH triggered: cannot map this agent to a story
      keyKind: keyByAgent[agentId]?.slice(0, 3) ?? null, // 'v2:' content-hash
      model, // null = FH: model not recoverable
      inputTokens: inTok,
      outputTokens: outTok,
      durationMs, // null = FH: duration not derivable
    })
  }
  recon.push({ runId, agents: agentFiles.length, journalResults: Object.keys(resultByAgent).length, runIn, runOut })
}

// 5. honest falsification verdict
const mapped = rows.filter((r) => r.story !== null).length
const v = {
  storyMapRate: rows.length ? `${mapped}/${rows.length}` : '0/0',
  storyMapped: rows.length > 0 && mapped === rows.length,
  modelRecovered: rows.length > 0 && rows.every((r) => r.model !== null),
  durationDerived: rows.length > 0 && rows.every((r) => r.durationMs !== null),
  keyIsContentHash: rows.length > 0 && rows.every((r) => r.keyKind === 'v2:'),
}
const out = { work, proj, runs: runDirs.length, agentEvents: rows, reconciliation: recon, falsification: v }

if (jsonMode) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log(`\nB1 harvester · ${work}`)
  console.log(`  transcript dir: ${proj}`)
  console.log(`  workflow runs found: ${runDirs.length}\n`)
  for (const r of rows)
    console.log(
      `  ${r.runId.slice(0, 12)} ${(r.story ?? '∅NO-STORY').padEnd(20)} ${(r.model ?? '∅NO-MODEL').padEnd(22)} in=${r.inputTokens} out=${r.outputTokens} dur=${r.durationMs ?? '∅'}ms`
    )
  console.log(`\n  reconciliation:`)
  for (const c of recon)
    console.log(`    ${c.runId.slice(0, 12)} agents=${c.agents} journalResults=${c.journalResults} tokIn=${c.runIn} tokOut=${c.runOut}`)
  console.log(`\n  FALSIFICATION:`)
  console.log(`    story mappable (hash→story via .result.story): ${v.storyMapRate} ${v.storyMapped ? '✓' : '⚠ partial — agents whose schema omits a step id are unmappable'}`)
  console.log(`    model recovered:                               ${v.modelRecovered ? '✓' : '✗ FH'}`)
  console.log(`    durationMs derivable (from timestamps):        ${v.durationDerived ? '✓ (derived, not native)' : '✗ FH'}`)
  console.log(`    journal key is opaque content-hash:            ${v.keyIsContentHash ? '⚠ yes — re-keying needs a step id in the agent return' : 'no'}`)
  const recoverable = v.modelRecovered && v.durationDerived
  console.log(
    `\n  verdict: ${recoverable ? 'RECOVERABLE — telemetry exists in transcripts; §12 continuity is achievable via a host-local scrape harvester PLUS a schema convention (every agent() return MUST carry a stable stepId). NOT a one-line emit; couples to undocumented paths (O3).' : 'BLOCKED — telemetry not recoverable from transcripts; §12 needs a runtime change'}\n`
  )
}
