/**
 * wave-vqa-runner.mjs — v2.6 wave-gate dynamic VQA (M2, 2026-06-11).
 *
 * Judged visual QA moves OFF the per-story worktree (dino1 judged the
 * starter page; pacman1's DEV invented demo harnesses; pacman2's viewport
 * showed a SIBLING's stacked preview) and into the wave-merge CANDIDATE —
 * the first place the real integrated product exists. The verifier is
 * dynamic/agentic instead of a static scroll-0 screenshot:
 *
 *   boot → evidence agent (navigates, isolates each story's feature surface
 *   via /?feature=<slug>, reports WHAT IS ACTUALLY IN FRAME) → verifiability
 *   gate → judge panel (rigor-scaled N, distinct lenses) → triage
 *   (code-bug | environment | ac-wording) → capped in-candidate fixer →
 *   fix-forward.
 *
 * FIX-FORWARD SEMANTICS (decision, do not re-litigate): judged failures
 * NEVER block the green advance — they produce handoff packets, attention
 * cards and (M5) auto-minted fix stories. Deterministic failures (server
 * no-boot) DO block, exactly like a build failure.
 *
 * Every failure travels as a HANDOFF PACKET (.context/vqa-handoffs/<acId>.json,
 * committed — evidence is preserved, invariant I4; note `.pipeline/` is
 * gitignored by the template, so `.context/` is the ship-in-green location).
 *
 * NO HARDCODING: surfaces derive from touchPoints + the feature-file
 * convention; UI-bearing from qaContext; rigor from the plan row. The module
 * is dependency-injected (spawners/shell/git/boot) and tested hermetically.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EVIDENCE_FENCE = /---EVIDENCE_JSON---([\s\S]*?)---END_EVIDENCE_JSON---/;
const TRIAGE_FENCE = /---TRIAGE_JSON---([\s\S]*?)---END_TRIAGE_JSON---/;
const FEATURE_FILE_RE = /^src\/features\/([^/]+)\.feature\.tsx$/;
// Same static parse as scripts/generate-wiring.mjs — never executes app code.
const SLUG_RE = /slug\s*:\s*['"`]([^'"`]+)['"`]/;

/** Extract a fenced JSON array from agent output; null when absent/invalid. */
export function parseFencedJson(output, fence) {
  const m = (output || '').match(fence);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Feature slugs a story registered, derived from its touchPoints matching
 * the feature-file convention, reading each file's exported descriptor from
 * the CANDIDATE (post-merge truth, not the PM's guess).
 */
export function featureSlugsForStory(story, candidateDir) {
  const slugs = [];
  for (const tp of story.touchPoints || []) {
    const m = FEATURE_FILE_RE.exec(tp);
    if (!m) continue;
    try {
      const src = readFileSync(join(candidateDir, tp), 'utf8');
      const slug = SLUG_RE.exec(src)?.[1];
      if (slug) slugs.push(slug);
    } catch {
      /* file absent in merged tree — root capture fallback */
    }
  }
  return slugs;
}

/**
 * Panel consensus for one AC. `votes`: [{lens, verdict, confidence, observation}].
 * CONFIRMED FAIL = strict majority FAIL with at least one high-confidence
 * vote (mirrors review-runtime's "only confident fails drive fixes").
 * Majority UNREACHABLE → unverifiable. Anything else non-blocking.
 */
export function judgeConsensus(votes) {
  const n = votes.length;
  if (n === 0) return { result: 'UNCERTAIN' };
  const count = (v) => votes.filter((x) => x.verdict === v).length;
  const fails = votes.filter((x) => x.verdict === 'FAIL');
  if (fails.length * 2 > n && fails.some((x) => x.confidence === 'high')) {
    return { result: 'FAIL', observation: fails.map((f) => f.observation).join(' | ') };
  }
  if (count('UNREACHABLE') * 2 > n) return { result: 'UNVERIFIABLE' };
  if (count('PASS') * 2 > n) return { result: 'PASS' };
  return { result: 'UNCERTAIN' };
}

/** Parse one judge's output per the VERDICT/OBSERVATION contract. */
export function parseJudgeOutput(output) {
  const vm = (output || '').match(
    /VERDICT:\s*(PASS|FAIL|UNREACHABLE|UNCERTAIN)\s*(?:\[conf=(high|low)\])?/i,
  );
  if (!vm) return null;
  const om = (output || '').match(/OBSERVATION:\s*(.+)/i);
  return {
    verdict: vm[1].toUpperCase(),
    confidence: (vm[2] || 'low').toLowerCase(),
    observation: (om?.[1] || '').trim().slice(0, 300),
  };
}

const JUDGE_LENSES = {
  strict:
    'Judge ONLY the literal text of the acceptance criterion against the pixels. Do not infer intent beyond the words.',
  layout:
    'Attend to composition: counts, positions, colors, sizes, alignment and what occupies each screen region. Verify the SPATIAL claims of the criterion.',
  skeptic:
    'Assume the implementation is probably correct and the screenshot may be misleading. FAIL only on an undeniable, citable contradiction visible in the frame.',
};

function lensesForRigor(rigor) {
  return rigor === 'production' ? ['strict', 'layout', 'skeptic'] : ['strict', 'layout'];
}

function buildEvidencePrompt({ storiesInput, port, healthPath, shotDir }) {
  return [
    'You are the wave-gate visual EVIDENCE agent. A dev server for the merged',
    `candidate is ALREADY RUNNING at http://localhost:${port}${healthPath} — do NOT start,`,
    'stop or restart it, and do NOT run a build.',
    '',
    'INPUT — stories merged in this wave, with their registered feature slugs',
    'and the browser-verifiable acceptance criteria to capture evidence for:',
    '```json',
    JSON.stringify(storiesInput, null, 2),
    '```',
    '',
    'For EACH story, capture PNG screenshot evidence of ITS OWN surface:',
    `1. Prefer feature isolation: http://localhost:${port}/?feature=<slug> for each`,
    '   of the story\'s featureSlugs (the generated page renders ONLY that feature).',
    `2. If a feature page renders empty/meaningless, try the composed root and the`,
    '   anchored section #feature-<slug> (scroll it into view before shooting).',
    '3. If the story has no featureSlugs, capture the composed root.',
    `Also capture the composed root once as ${shotDir}/root.png.`,
    '',
    `Write ALL screenshots under ${shotDir}/ (it exists). Use`,
    "`npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=2500 <url> <file.png>`",
    'or, when you need scrolling/clipping, a small node script using the',
    'playwright library available at /opt/futurator-daemon/node_modules.',
    '',
    'YOU ARE READ-ONLY IN THIS REPOSITORY: do not create, modify or delete ANY',
    `file inside the repo. Write only under ${shotDir}/ and /tmp.`,
    '',
    'FINALLY output a fenced JSON array — ONE entry PER acceptance criterion',
    '(entries for the same story may reuse one screenshot):',
    '---EVIDENCE_JSON---',
    '[{"storyId": "...", "acId": "...", "screenshotPath": "<absolute path>",',
    '  "url": "<the URL captured>",',
    '  "capturedSurface": "<one sentence: what is ACTUALLY in this frame>",',
    '  "verifiable": true,',
    '  "whyNotVerifiable": null}]',
    '---END_EVIDENCE_JSON---',
    '',
    'Set verifiable=false (with whyNotVerifiable) when the idle frame you can',
    "capture physically cannot show the criterion's state — it requires user",
    'interaction, elapsed time, a score/progress threshold, or a route/state',
    'the app does not render at load. Report honestly what is in frame; the',
    'judges rely on capturedSurface to know what they are looking at.',
  ].join('\n');
}

function buildJudgePrompt({ ac, evidence, lens, storyTitle }) {
  return [
    'You are an automated visual reviewer on a wave-gate judge panel.',
    `Use the Read tool to open the screenshot image file at ${evidence.screenshotPath} and inspect it.`,
    '',
    `Story: ${storyTitle}`,
    `The evidence agent reports this frame shows: ${evidence.capturedSurface || '(no description)'}`,
    `Captured URL: ${evidence.url || '(unknown)'}`,
    '',
    'This is a SINGLE STATIC FRAME at idle: no clicks, no keypresses, no',
    'elapsed time, nothing in motion. You see the load state only.',
    '',
    'Acceptance criterion to judge:',
    `  ${ac.id}: ${ac.text}`,
    '',
    `YOUR LENS — ${lens}: ${JUDGE_LENSES[lens]}`,
    '',
    'Verdict rules, in order:',
    '1. REACHABILITY: if this idle frame physically cannot show the state the',
    '   criterion describes (interaction/time/route/composite required), output',
    '   UNREACHABLE — never FAIL an unreachable criterion.',
    '2. PASS — the frame observably satisfies it.',
    '3. FAIL — the frame CONTRADICTS it; cite the concrete contradicting',
    '   observation. conf=high only when unambiguous.',
    '4. UNCERTAIN — unreadable image or genuinely too close to call.',
    '',
    'Output EXACTLY two lines:',
    'VERDICT: PASS|FAIL|UNREACHABLE|UNCERTAIN [conf=high|low]',
    'OBSERVATION: <≤200 chars — what you actually see relevant to the criterion>',
  ].join('\n');
}

function buildTriagePrompt({ failures, recentLog }) {
  return [
    'You are the wave-gate VQA TRIAGE agent. A judge panel confirmed the',
    'following visual failures on the merged candidate (dev server rendered,',
    'page was not blank — these are content-level contradictions):',
    '```json',
    JSON.stringify(failures, null, 2),
    '```',
    '',
    'Recent candidate history (commits + files touched):',
    '```',
    recentLog,
    '```',
    '',
    'You may read any file in the repository to ground your classification.',
    'Classify EACH failure:',
    '- "code-bug": the product code does not produce what the criterion',
    '  describes — fixable by changing story-owned source files.',
    '- "environment": the frame shows a dev-server/build artifact problem',
    '  (error overlay, stale/corrupted cache output, wrong app entirely).',
    '- "ac-wording": the criterion is ambiguous or describes a state an idle',
    '  frame cannot show; the code is plausibly correct.',
    '',
    'Output a fenced JSON array, one entry per failure:',
    '---TRIAGE_JSON---',
    '[{"acId": "...", "classification": "code-bug|environment|ac-wording",',
    '  "suspectedFiles": ["src/..."], "summary": "expected X, observed Y, likely Z"}]',
    '---END_TRIAGE_JSON---',
  ].join('\n');
}

function buildFixerPrompt({ handoffs, validationCmd, round }) {
  return [
    'You are the wave-gate VQA FIXER, working in the merged candidate worktree.',
    'A judge panel confirmed the visual failures below against screenshots of',
    'the RUNNING app; triage classified them as code bugs. Each handoff packet',
    'contains the criterion, the judges\' observations, what surface was',
    'captured, suspected files, and prior attempts.',
    '',
    round > 1 ? `This is fix round ${round} — earlier attempts are recorded in attempts[].` : '',
    '',
    'HANDOFF PACKETS:',
    '```json',
    JSON.stringify(handoffs, null, 2),
    '```',
    '',
    'The same packets are on disk at .context/vqa-handoffs/<acId>.json, and',
    "each owning story's intent is in .context/wave-*-story-*.md — read the",
    'relevant ones before changing anything.',
    '',
    'RULES:',
    '1. Make the SMALLEST change that makes the failing criteria hold on the',
    "   idle frame while preserving every story's intended functionality.",
    '2. Never weaken ASSERTIONS: do not delete or loosen what a test checks,',
    '   do not add ts-ignore/any-casts. You MAY repair test INFRASTRUCTURE',
    '   while preserving intent.',
    '3. Do NOT touch package.json, lockfiles, build/test/lint configs, or',
    '   @generated files — regenerate generated files via their script instead.',
    '4. NEVER add new routes, pages, demo galleries, or UI surfaces the story',
    '   did not ask for just to satisfy a screenshot.',
    `5. You may run \`${validationCmd}\` yourself to iterate — it must pass.`,
    '6. Each packet has a verifyCommand describing how the evidence will be',
    '   re-captured; you may reproduce it (use a DIFFERENT port, e.g. +1, and',
    '   kill your own server afterwards).',
    '7. Do NOT run git commit/push — the runner commits with an audit trailer.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildHandoff({ story, ac, votes, evidence, triage, attempts, port }) {
  const slugHint = evidence?.url?.match(/[?&]feature=([^&]+)/)?.[1];
  return {
    storyId: story.storyId,
    storyTitle: story.title || '',
    acId: ac.id,
    acText: ac.text,
    verdicts: votes.map((v) => ({
      lens: v.lens,
      verdict: v.verdict,
      confidence: v.confidence,
      observation: v.observation,
    })),
    evidence: {
      screenshotUrl: evidence?.screenshotUrl || null,
      screenshotPath: evidence?.screenshotPath || null,
      capturedSurface: evidence?.capturedSurface || '',
      url: evidence?.url || null,
    },
    triage: triage
      ? {
          classification: triage.classification,
          suspectedFiles: triage.suspectedFiles || [],
          summary: triage.summary || '',
        }
      : null,
    attempts: attempts || [],
    expected: ac.text,
    observed: votes
      .filter((v) => v.verdict === 'FAIL')
      .map((v) => v.observation)
      .join(' | '),
    verifyCommand: `boot dev server; screenshot http://localhost:${port}/${
      slugHint ? `?feature=${slugHint}` : ''
    }; the criterion must hold on the idle frame`,
  };
}

/** Render the wave VQA knowledge report (committed into the candidate). */
export function renderVqaReport({ waveNumber, verdicts, fixesApplied, fixForward, unverifiable }) {
  const lines = [
    `# Wave ${waveNumber} — visual QA report`,
    '',
    '> Generated by the wave-gate VQA runner. Judged against the MERGED',
    '> candidate, per-feature isolation via `/?feature=<slug>`.',
    '',
    '| story | AC | result | observation |',
    '|---|---|---|---|',
  ];
  for (const v of verdicts) {
    lines.push(
      `| ${v.storyId} | ${v.acId} | ${v.result} | ${(v.observation || v.capturedSurface || '').replace(/\|/g, '\\|').slice(0, 160)} |`,
    );
  }
  lines.push('');
  if (fixesApplied.length > 0) {
    lines.push('## Fixes applied in the candidate', '');
    for (const f of fixesApplied) lines.push(`- ${f.acIds.join(', ')} — ${f.summary}`);
    lines.push('');
  }
  if (fixForward.length > 0) {
    lines.push('## Fix-forward (advanced with known failures)', '');
    for (const h of fixForward)
      lines.push(
        `- ${h.acId} (${h.storyId}): expected "${h.expected.slice(0, 120)}" — observed "${(h.observed || '').slice(0, 120)}"`,
      );
    lines.push('');
  }
  if (unverifiable.length > 0) {
    lines.push('## Not verifiable from an idle frame', '');
    for (const u of unverifiable)
      lines.push(`- ${u.acId} (${u.storyId}): ${u.whyNotVerifiable || u.observation || ''}`);
    lines.push('');
  }
  lines.push(
    '## Screenshots',
    '',
    ...verdicts.filter((v) => v.screenshotUrl).map((v) => `- ${v.acId}: ${v.screenshotUrl}`),
    '',
  );
  return lines.join('\n');
}

/** Small concurrency pool — judge panels are cheap but the host is shared. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Run the dynamic VQA stage inside the wave gate. See module docblock.
 *
 * @returns {{ outcome: 'pass'|'fixed'|'fix-forward'|'skipped'|'env-blocked',
 *             verdicts: Array, fixesApplied: Array, fixForward: Array,
 *             unverifiable: Array, reportPath: string|null,
 *             bootLogTail?: string }}
 */
export async function runWaveVqa({
  candidateDir,
  stories,
  rigor,
  qaContext,
  planId,
  epicId,
  waveNumber,
  appId,
  validationCmd,
  spawnEvidence,
  spawnJudge,
  spawnTriage,
  spawnFixer,
  shell,
  git,
  writeAttention = async () => {},
  log = () => {},
  s3Prefix = 'review-screenshots',
  bootServer, // ({cwd, qaContext, port, shell, log}) => boot result — injected
  cleanReboot, // ({boot, qaContext, cwd, shell, log}) => boot result — injected
  // Wave gate uses an OFFSET port: story review servers use the default port
  // on the same host and draining it would kill them mid-screenshot.
  portOffset = 700,
  judgePoolSize = 3,
}) {
  const empty = { verdicts: [], fixesApplied: [], fixForward: [], unverifiable: [], reportPath: null };
  const vlog = (level, msg) => log(level, `[wave-vqa] ${msg}`);

  // ── Skip gates (defense in depth; the handler pre-gates too) ─────────────
  if (rigor === 'prototype') return { outcome: 'skipped', reason: 'prototype-rigor', ...empty };
  if (!qaContext) return { outcome: 'skipped', reason: 'no-qa-context', ...empty };
  const withBrowserAcs = (stories || [])
    .map((s) => ({
      ...s,
      browserAcs: (s.criteria || []).filter((c) => c.needsBrowser),
    }))
    .filter((s) => s.browserAcs.length > 0);
  if (withBrowserAcs.length === 0) {
    return { outcome: 'skipped', reason: 'no-browser-acs', ...empty };
  }

  const port = (qaContext.defaultPort ?? 3000) + portOffset;
  const healthPath = qaContext.healthcheckPath ?? '/';
  const shotDir = `/tmp/wave-vqa-${epicId}-${waveNumber}-${Date.now()}`;
  mkdirSync(shotDir, { recursive: true });

  // ── 1. Boot (deterministic — failure blocks like a build failure) ───────
  vlog('info', `stage=boot port=${port} stories=${withBrowserAcs.length}`);
  let boot = await bootServer({ cwd: candidateDir, qaContext, port, shell, log });
  if (!boot.ok) {
    vlog('error', `dev server failed to boot (status=${boot.status}) — env-blocked`);
    return { outcome: 'env-blocked', bootLogTail: boot.logTail, ...empty };
  }

  const verdicts = [];
  const fixesApplied = [];
  const fixForward = [];
  const unverifiable = [];

  try {
    // ── 2. Evidence (agentic, read-only — enforced after every spawn) ─────
    // Reusable: the fix loop and env-fix path RE-CAPTURE evidence for the
    // failing ACs (judging a pre-fix screenshot would always still fail).
    const captureEvidence = async (subset) => {
      const storiesInput = subset.map((s) => ({
        storyId: s.storyId,
        storyTitle: s.title || '',
        featureSlugs: featureSlugsForStory(s, candidateDir),
        acs: s.browserAcs.map((c) => ({ id: c.id, text: c.text })),
      }));
      vlog('info', `stage=evidence acs=${storiesInput.reduce((n, s) => n + s.acs.length, 0)}`);
      const ev = await spawnEvidence({
        prompt: buildEvidencePrompt({ storiesInput, port, healthPath, shotDir }),
        cwd: candidateDir,
      });

      // Read-only enforcement: any repo mutation by the evidence agent is
      // reverted and reported loudly (it can taint the merged tree).
      const dirty = await git(['status', '--porcelain'], candidateDir);
      if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
        vlog('warn', `evidence agent dirtied the candidate — hard reset:\n${dirty.stdout.slice(0, 500)}`);
        await git(['reset', '--hard'], candidateDir);
        await git(['clean', '-fd'], candidateDir);
      }

      const evidence = ev?.ok !== false ? parseFencedJson(ev?.output, EVIDENCE_FENCE) : null;
      if (!evidence) return { ok: false, tail: (ev?.output || ev?.reason || '').slice(-600) };

      // Upload screenshots (non-blocking, LOUD on fail) and index by acId.
      const byAc = new Map();
      for (const e of evidence) {
        if (e.screenshotPath && existsSync(e.screenshotPath)) {
          const key = `${s3Prefix}/wave-${epicId}-${waveNumber}/${String(e.acId).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.png`;
          const up = await shell(
            `timeout 30 aws s3 cp ${e.screenshotPath} "s3://futurator-ai-website/${key}" --content-type image/png`,
            candidateDir,
            45_000,
          );
          if (up.code === 0) e.screenshotUrl = `https://futurator.ai/${key}`;
          else vlog('warn', `SCREENSHOT_UPLOAD_FAILED for ${e.acId}: ${(up.stderr || '').slice(0, 200)}`);
        }
        byAc.set(e.acId, e);
      }
      return { ok: true, byAc };
    };

    /** Subset of stories carrying ONLY the given failing ACs (for re-capture). */
    const subsetFor = (items) => {
      const acIds = new Set(items.map((r) => r.ac.id));
      return withBrowserAcs
        .map((s) => ({ ...s, browserAcs: s.browserAcs.filter((c) => acIds.has(c.id)) }))
        .filter((s) => s.browserAcs.length > 0);
    };

    const first = await captureEvidence(withBrowserAcs);
    if (!first.ok) {
      vlog('warn', 'evidence agent produced no parseable EVIDENCE_JSON — skipping judged VQA (non-blocking)');
      await writeAttention({
        category: 'wave-vqa-unverifiable',
        severity: 'low',
        title: `Wave ${waveNumber} VQA could not gather evidence`,
        body: `The evidence agent produced no parseable output; judged VQA was skipped for this wave. Agent tail: ${first.tail}`,
        dedupKey: `wave-vqa-evidence:${planId}:${epicId}:${waveNumber}`,
        context: { planId, epicId, waveNumber },
      });
      return { outcome: 'skipped', reason: 'evidence-unparseable', ...empty };
    }
    const evByAc = first.byAc;
    const acIndex = new Map();
    for (const s of withBrowserAcs) for (const c of s.browserAcs) acIndex.set(c.id, { story: s, ac: c });

    // ── 3. Verifiability gate ─────────────────────────────────────────────
    const toJudge = [];
    for (const [acId, { story, ac }] of acIndex) {
      const e = evByAc.get(acId);
      if (!e || e.verifiable === false || !e.screenshotPath || !existsSync(e.screenshotPath)) {
        unverifiable.push({
          storyId: story.storyId,
          acId,
          whyNotVerifiable: e?.whyNotVerifiable || (e ? 'no usable screenshot' : 'no evidence entry'),
        });
        verdicts.push({
          storyId: story.storyId,
          acId,
          result: 'UNVERIFIABLE',
          capturedSurface: e?.capturedSurface,
          screenshotUrl: e?.screenshotUrl,
          observation: e?.whyNotVerifiable || '',
        });
      } else {
        toJudge.push({ story, ac, evidence: e });
      }
    }
    vlog('info', `stage=verifiability judge=${toJudge.length} unverifiable=${unverifiable.length}`);

    // ── 4. Judge panel ────────────────────────────────────────────────────
    const lenses = lensesForRigor(rigor);
    const judgeOne = async ({ story, ac, evidence: e }) => {
      const votes = await mapPool(lenses, judgePoolSize, async (lens) => {
        const j = await spawnJudge({
          prompt: buildJudgePrompt({ ac, evidence: e, lens, storyTitle: story.title || '' }),
          cwd: candidateDir,
        });
        const parsed = j?.ok !== false ? parseJudgeOutput(j?.output) : null;
        return parsed
          ? { lens, ...parsed }
          : { lens, verdict: 'UNCERTAIN', confidence: 'low', observation: 'judge unparseable' };
      });
      const consensus = judgeConsensus(votes);
      return { story, ac, evidence: e, votes, consensus };
    };
    // Re-capture + re-judge a set of failing items against the CURRENT tree
    // (post-fix / post-reboot). Judging a stale pre-fix screenshot would
    // always still fail; missing fresh evidence keeps the old (conservative).
    const rejudge = async (items) => {
      const fresh = await captureEvidence(subsetFor(items));
      return mapPool(items, 2, (r) => {
        const e = fresh.ok ? fresh.byAc.get(r.ac.id) : null;
        if (e && e.verifiable !== false && e.screenshotPath && existsSync(e.screenshotPath)) {
          return judgeOne({ story: r.story, ac: r.ac, evidence: e });
        }
        return judgeOne(r);
      });
    };

    const judged = await mapPool(toJudge, 2, judgeOne);
    for (const r of judged) {
      verdicts.push({
        storyId: r.story.storyId,
        acId: r.ac.id,
        result: r.consensus.result,
        observation: r.consensus.observation || r.votes.map((v) => v.observation).find(Boolean) || '',
        capturedSurface: r.evidence.capturedSurface,
        screenshotUrl: r.evidence.screenshotUrl,
      });
    }
    let confirmed = judged.filter((r) => r.consensus.result === 'FAIL');
    vlog(
      'info',
      `stage=judge confirmed-fails=${confirmed.length} of ${judged.length} judged (${lenses.length} lenses)`,
    );

    // ── 5. Triage confirmed fails ─────────────────────────────────────────
    let triageByAc = new Map();
    if (confirmed.length > 0 && spawnTriage) {
      const recent = await git(['log', '--oneline', '--stat', '-12'], candidateDir);
      const t = await spawnTriage({
        prompt: buildTriagePrompt({
          failures: confirmed.map((r) => ({
            storyId: r.story.storyId,
            acId: r.ac.id,
            acText: r.ac.text,
            capturedSurface: r.evidence.capturedSurface,
            observations: r.votes.filter((v) => v.verdict === 'FAIL').map((v) => v.observation),
            storyTouchPoints: r.story.touchPoints || [],
          })),
          recentLog: (recent.stdout || '').slice(-4000),
        }),
        cwd: candidateDir,
      });
      const triage = t?.ok !== false ? parseFencedJson(t?.output, TRIAGE_FENCE) : null;
      for (const item of triage || []) triageByAc.set(item.acId, item);
    }
    // Default classification: code-bug (the actionable path).
    const classOf = (acId) => triageByAc.get(acId)?.classification || 'code-bug';

    // ── 5b. Environment-classed: cache clean + reboot + re-evidence once ──
    const envFails = confirmed.filter((r) => classOf(r.ac.id) === 'environment');
    if (envFails.length > 0 && cleanReboot) {
      vlog('info', `stage=env-fix ${envFails.length} environment-classed failure(s) — cache clean + reboot`);
      boot = await cleanReboot({ boot, qaContext, cwd: candidateDir, shell, log });
      if (boot.ok) {
        const recheck = await rejudge(envFails);
        const cleared = new Set(
          recheck.filter((x) => x.consensus.result !== 'FAIL').map((x) => x.ac.id),
        );
        for (const r of recheck) {
          const v = verdicts.find((x) => x.acId === r.ac.id);
          if (v) {
            v.result = r.consensus.result;
            v.observation = r.consensus.observation || v.observation;
          }
        }
        confirmed = confirmed.filter(
          (r) => !(classOf(r.ac.id) === 'environment' && cleared.has(r.ac.id)),
        );
        // A reboot didn't clear it ⇒ triage misread (or the env damage is in
        // committed output) — route the survivors through the fixer path
        // instead of letting them silently fall out of every ladder rung.
        for (const r of recheck.filter((x) => x.consensus.result === 'FAIL')) {
          const t = triageByAc.get(r.ac.id);
          if (t) t.classification = 'code-bug';
          const idx = confirmed.findIndex((c) => c.ac.id === r.ac.id);
          if (idx >= 0) confirmed[idx] = r; // carry the FRESH evidence/votes
        }
      }
    }

    // ── 5c. ac-wording: contested, non-blocking ──────────────────────────
    const wording = confirmed.filter((r) => classOf(r.ac.id) === 'ac-wording');
    for (const r of wording) {
      await writeAttention({
        category: 'ac-contested',
        severity: 'low',
        title: `Wave ${waveNumber} VQA: ${r.ac.id} likely mis-worded`,
        body: `Triage: ${triageByAc.get(r.ac.id)?.summary || 'criterion not verifiable as worded'}\nAC: ${r.ac.text}`,
        dedupKey: `wave-vqa-wording:${planId}:${epicId}:${waveNumber}:${r.ac.id}`,
        context: { planId, epicId, waveNumber, storyId: r.story.storyId, acId: r.ac.id },
      });
      const v = verdicts.find((x) => x.acId === r.ac.id);
      if (v) v.result = 'CONTESTED';
    }
    confirmed = confirmed.filter((r) => classOf(r.ac.id) === 'code-bug');

    // ── 6. Capped fix rounds in the candidate ─────────────────────────────
    const maxRounds = rigor === 'production' ? 2 : 1;
    const attemptsByAc = new Map();
    const handoffDir = join(candidateDir, '.context', 'vqa-handoffs');
    const writeHandoffs = (rows) => {
      mkdirSync(handoffDir, { recursive: true });
      for (const h of rows) {
        writeFileSync(
          join(handoffDir, `${String(h.acId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
          JSON.stringify(h, null, 2) + '\n',
          'utf8',
        );
      }
    };

    for (let round = 1; confirmed.length > 0 && spawnFixer && round <= maxRounds; round++) {
      const handoffs = confirmed.map((r) =>
        buildHandoff({
          story: r.story,
          ac: r.ac,
          votes: r.votes,
          evidence: r.evidence,
          triage: triageByAc.get(r.ac.id),
          attempts: attemptsByAc.get(r.ac.id) || [],
          port,
        }),
      );
      writeHandoffs(handoffs);
      vlog('info', `stage=fix round=${round}/${maxRounds} failures=${confirmed.length}`);

      // The dev server holds the build cache — stop it before fixer +
      // validation (next build and next dev contend on the same cache dir).
      await boot.stop();
      const preSha = (await git(['rev-parse', 'HEAD'], candidateDir)).stdout.trim();
      const fix = await spawnFixer({
        prompt: buildFixerPrompt({ handoffs, validationCmd, round }),
        cwd: candidateDir,
        round,
      });
      if (!fix?.attempted) {
        vlog('warn', `fixer did not attempt (${fix?.reasoning || 'no reason'}) — fix-forward`);
        boot = await bootServer({ cwd: candidateDir, qaContext, port, shell, log });
        break;
      }
      const reval = validationCmd ? await shell(validationCmd, candidateDir, 900_000) : { code: 0 };
      if (reval.code !== 0) {
        vlog('warn', `fix round ${round} broke the validation gate — reverting fixer changes`);
        await git(['reset', '--hard', preSha], candidateDir);
        await git(['clean', '-fd'], candidateDir);
        for (const r of confirmed) {
          const a = attemptsByAc.get(r.ac.id) || [];
          a.push({ round, fixer: 'attempt reverted: broke validation gate', result: 'reverted' });
          attemptsByAc.set(r.ac.id, a);
        }
        boot = await bootServer({ cwd: candidateDir, qaContext, port, shell, log });
        continue;
      }

      // Commit the validation-green fix BEFORE re-judging: the evidence
      // agent's read-only enforcement requires a clean tree (it hard-resets
      // any dirt), and a fix that survived the full gate is green-gated by
      // construction. Reverted below if the re-judge shows ZERO improvement
      // (horse-runner1 lesson: never keep an unjustified code mutation just
      // because a screenshot loop produced it).
      await git(['add', '-A'], candidateDir);
      const attemptedAcIds = confirmed.map((r) => r.ac.id);
      const c = await git(
        [
          '-c', 'user.email=daemon@futurator.local',
          '-c', 'user.name=Daemon',
          'commit', '-m',
          `wave ${waveNumber}: vqa-fix — ${attemptedAcIds.join(', ')}\n\nRound ${round}. ${(fix.reasoning || '').slice(0, 700)}`,
        ],
        candidateDir,
      );
      const committed = c.code === 0;
      if (!committed && !/nothing to commit/.test(c.stdout + c.stderr)) {
        vlog('warn', `vqa-fix commit failed: ${(c.stderr || '').slice(0, 200)}`);
      }

      // Re-evidence + re-judge ONLY the failing ACs against the fixed tree.
      boot = await bootServer({ cwd: candidateDir, qaContext, port, shell, log });
      if (!boot.ok) {
        vlog('warn', 'server did not reboot after fix — reverting fixer changes');
        await git(['reset', '--hard', preSha], candidateDir);
        await git(['clean', '-fd'], candidateDir);
        boot = await bootServer({ cwd: candidateDir, qaContext, port, shell, log });
        break;
      }
      const recheck = await rejudge(confirmed);
      const nowPassing = recheck.filter((r) => r.consensus.result !== 'FAIL');
      const stillFailing = recheck.filter((r) => r.consensus.result === 'FAIL');
      for (const r of recheck) {
        const v = verdicts.find((x) => x.acId === r.ac.id);
        if (v) {
          v.result = r.consensus.result === 'FAIL' ? 'FAIL' : `FIXED:${r.consensus.result}`;
          v.observation = r.consensus.observation || v.observation;
        }
      }
      if (nowPassing.length === 0) {
        // Zero improvement — drop the mutation entirely.
        if (committed) {
          vlog('warn', `fix round ${round} improved nothing — reverting the vqa-fix commit`);
          await git(['reset', '--hard', preSha], candidateDir);
          await git(['clean', '-fd'], candidateDir);
        }
      } else {
        const acIds = nowPassing.map((r) => r.ac.id);
        fixesApplied.push({ round, acIds, summary: (fix.reasoning || '').slice(0, 300) });
        vlog('info', `fix round ${round} fixed ${acIds.join(', ')} (committed)`);
      }
      for (const r of stillFailing) {
        const a = attemptsByAc.get(r.ac.id) || [];
        a.push({ round, fixer: (fix.reasoning || '').slice(0, 300), result: 'still-failing' });
        attemptsByAc.set(r.ac.id, a);
      }
      confirmed = stillFailing;
    }

    // ── 7. Fix-forward — judged failures NEVER block green ───────────────
    for (const r of confirmed) {
      const handoff = buildHandoff({
        story: r.story,
        ac: r.ac,
        votes: r.votes,
        evidence: r.evidence,
        triage: triageByAc.get(r.ac.id),
        attempts: attemptsByAc.get(r.ac.id) || [],
        port,
      });
      fixForward.push(handoff);
      await writeAttention({
        category: 'wave-vqa-failed',
        severity: 'medium',
        title: `Wave ${waveNumber} VQA: ${r.ac.id} failed (advanced fix-forward)`,
        body: `${r.ac.text}\n\nObserved: ${handoff.observed || '(see verdicts)'}\nCaptured surface: ${r.evidence.capturedSurface || '?'}`,
        dedupKey: `wave-vqa:${planId}:${epicId}:${waveNumber}:${r.story.storyId}`,
        context: {
          planId,
          epicId,
          waveNumber,
          storyId: r.story.storyId,
          handoff,
          screenshotUrl: r.evidence.screenshotUrl,
        },
      });
    }
    if (fixForward.length > 0) writeHandoffs(fixForward);

    // Story-level "nothing was verifiable" card (LOW) — one per story whose
    // every browser AC fell out at the verifiability gate.
    for (const s of withBrowserAcs) {
      const acIds = s.browserAcs.map((c) => c.id);
      const unv = unverifiable.filter((u) => u.storyId === s.storyId);
      if (unv.length === acIds.length && acIds.length > 0) {
        await writeAttention({
          category: 'wave-vqa-unverifiable',
          severity: 'low',
          title: `Wave ${waveNumber} VQA: no AC of ${s.title || s.storyId} was verifiable`,
          body: unv.map((u) => `${u.acId}: ${u.whyNotVerifiable}`).join('\n'),
          dedupKey: `wave-vqa-unverifiable:${planId}:${epicId}:${waveNumber}:${s.storyId}`,
          context: { planId, epicId, waveNumber, storyId: s.storyId },
        });
      }
    }

    // ── 8. Knowledge report (committed — next waves + COMPILER read it) ──
    const reportRel = join('.context', `wave-${waveNumber}-vqa-report.md`);
    const reportAbs = join(candidateDir, reportRel);
    mkdirSync(join(candidateDir, '.context'), { recursive: true });
    writeFileSync(
      reportAbs,
      renderVqaReport({ waveNumber, verdicts, fixesApplied, fixForward, unverifiable }),
      'utf8',
    );
    await git(['add', '.context'], candidateDir);
    const rc = await git(
      [
        '-c', 'user.email=daemon@futurator.local',
        '-c', 'user.name=Daemon',
        'commit', '-m',
        `wave ${waveNumber}: vqa report — ${verdicts.length} verdict(s), ${fixesApplied.length} fix(es), ${fixForward.length} fix-forward`,
      ],
      candidateDir,
    );
    if (rc.code !== 0 && !/nothing to commit/.test(rc.stdout + rc.stderr)) {
      vlog('warn', `vqa report commit failed (non-blocking): ${(rc.stderr || '').slice(0, 200)}`);
    }

    const outcome =
      fixForward.length > 0 ? 'fix-forward' : fixesApplied.length > 0 ? 'fixed' : 'pass';
    vlog(
      'info',
      `done outcome=${outcome} verdicts=${verdicts.length} fixed=${fixesApplied.length} fix-forward=${fixForward.length} unverifiable=${unverifiable.length}`,
    );
    return { outcome, verdicts, fixesApplied, fixForward, unverifiable, reportPath: reportRel };
  } finally {
    try {
      await boot.stop();
    } catch {
      /* best effort */
    }
  }
}
