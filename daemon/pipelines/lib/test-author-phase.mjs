// test-author-phase — W2.2 (P3_TEST_AUTHOR_SPLIT). The isolated Test-Author that
// precedes the Implementer, restoring the legacy test-first separation that P3
// collapsed. Kept in its own module (all primitives injected) so the live
// story-dev spawn loop is untouched and the default path is byte-identical.
//
// SAFETY: the caller runs this ONLY when P3_TEST_AUTHOR_SPLIT=on, and wraps it in
// try/catch → fail-open to the legacy single-spawn implementer. Any throw here
// degrades gracefully; it must never wedge a story.
//
// The daemon-side prompts are authored here (NOT extracted from the live
// functions/shared/pipelines/story-pipeline.ts TEST step — the safety review's
// hard constraint: never refactor a live production prompt).

import { parseBindingManifest, applyBindings } from '../../lib/completion-gate.mjs';
import { assertRedFirst } from '../../lib/tdd-gates.mjs';

/** Test-file matcher shared by the RED-commit staging + the gate scope. */
export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * pacman3 canary fix (2026-07-03): the RED commit staged only the story's
 * `touches`, which never include test files → "RED confirmed — 0 test file(s)"
 * and no tamper protection. Parse `git status --porcelain` for the authored
 * test files so commitRed can stage them explicitly. Handles renames. PURE.
 */
export function parsePorcelainTestFiles(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => {
      const p = l.slice(3).trim();
      return p.includes(' -> ') ? p.split(' -> ').pop().trim() : p;
    })
    .filter((f) => f && TEST_FILE_RE.test(f));
}

/**
 * The Test-Author prompt: author FAILING tests for each AC + emit <BINDING>.
 * Isolated context — it must not see or write implementation code (that would
 * reintroduce the circular validation the split exists to prevent). PURE.
 */
export function buildStoryTestPrompt(payload) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}${ac.acClass ? ` (${ac.acClass})` : ''}`)
    .join('\n');
  return [
    `You are the TEST AUTHOR in a spec-driven pipeline. You author the failing tests`,
    `for ONE story BEFORE any implementation exists. A separate agent implements next.`,
    ``,
    `# Story: ${payload.title}`,
    payload.intent ? `Intent: ${payload.intent}` : '',
    ``,
    `# Acceptance criteria — write one test per AC that PROVES it`,
    acLines,
    ``,
    `# Test-architecture knowledge (TEA)`,
    `If \`_bmad/tea/workflows/testarch/\` exists in this repo, skim these knowledge`,
    `fragments BEFORE authoring (they set the quality bar — isolation, no hard waits,`,
    `factories over fixtures-of-fixtures): knowledge files matching test-quality,`,
    `fixture-architecture, and data-factories under \`_bmad/tea/\`. Absent → proceed.`,
    ``,
    `# Rules (non-negotiable)`,
    `- Author ONLY test files. Do NOT write, stub, or scaffold implementation code.`,
    `- Each test MUST FAIL right now (the feature does not exist yet) — this is the RED state.`,
    `- Do not weaken a test to make it pass; a test that passes before implementation is invalid.`,
    `- CREATE new test files as SIBLINGS of the code under test (e.g. src/x/foo.test.ts for`,
    `  src/x/foo.ts). Test files (*.test.*, *.spec.*) are in scope; the story's implementation`,
    `  files are NOT yours to touch: ${(payload.touches || []).join(', ')}`,
    ``,
    `# Required: bind each AC to its test`,
    `<BINDING>`,
    `{ ${(payload.acceptanceCriteria || []).map((ac) => `"${ac.id}": { "testRef": "<test selector>", "testKind": "unit|integration|browser|manual" }`).join(', ')} }`,
    `</BINDING>`,
  ].filter((l) => l !== '').join('\n');
}

/**
 * The Implementer prompt (split variant): tests already exist and are committed;
 * implement the minimum to GREEN and NEVER touch the authored tests. PURE.
 */
export function buildImplementerPrompt(payload, ownedTestFiles = []) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}`)
    .join('\n');
  return [
    `You are the IMPLEMENTER in a spec-driven pipeline. The failing tests for this`,
    `story have ALREADY been authored and committed. Make them pass — nothing more.`,
    ``,
    `# Story: ${payload.title}`,
    ``,
    `# Acceptance criteria`,
    acLines,
    ``,
    `# The authored tests are the source of truth — you may NOT create, edit, or delete them:`,
    ...(ownedTestFiles.length ? ownedTestFiles.map((f) => `  - ${f}`) : ['  (see the committed test files)']),
    ``,
    `# Rules`,
    `- Write the MINIMUM implementation that makes the committed tests pass (GREEN).`,
    `- Do NOT modify the test files above. A gate auto-reverts any edit to them.`,
    `- You may ONLY create/modify files under: ${(payload.touches || []).join(', ')}`,
    payload.priorFailure
      ? '\n# Prior attempt failed the bound tests — fix ONLY this:\n' + payload.priorFailure
      : '',
  ].filter((l) => l !== '').join('\n');
}

/**
 * Run the Test-Author phase. All side-effecting primitives are injected so this
 * unit-tests without a CLI/git/test-runner.
 *
 * @param {{
 *   payload: object,
 *   headSha: string,
 *   spawnOnce: (args:{prompt:string}) => Promise<{ exitCode:number, text:string }>,
 *   commitRed: (args:{label:string}) => Promise<{ committed:boolean, sha?:string, files?:string[] }>,
 *   runBindings: (args:{acceptanceCriteria:object[], headSha:string}) => Promise<{ acceptanceCriteria:object[], summary:object }>,
 *   logger?: object,
 * }} deps
 * @returns {Promise<{ ownedTestFiles:string[], bindingOutput:string, redSha:string, boundCriteria:object[] }>}
 * @throws on any failure — the caller catches and falls open to the single-spawn path.
 */
export async function runTestAuthorPhase({ payload, headSha, spawnOnce, commitRed, runBindings, logger }) {
  const log = (m) => { try { logger?.info?.(`[test-author] ${m}`); } catch { /* ignore */ } };

  // RETRY IDEMPOTENCY (pacman4 forensic, 2026-07-05): a revived/retried story
  // whose ACs are ALREADY BOUND (a prior attempt authored + committed the RED
  // tests) must NOT re-author — the shared worktree may hold that attempt's
  // leftover implementation, so freshly-authored tests can pass immediately and
  // the RED-first gate rejects the whole phase (a wasted spawn + lost
  // isolation). Instead: reuse the committed tests. Bindings all RED → proceed
  // straight to the implementer with the existing tests as the baseline. Any
  // already GREEN → the prior implementation is present; throw a DISTINCT
  // reason so the caller's fail-open single-spawn finishes the story (its
  // completion gate re-verifies every binding honestly).
  const acs = payload.acceptanceCriteria || [];
  const priorBound = acs.filter((a) => a?.testBinding?.testRef);
  if (acs.length > 0 && priorBound.length === acs.length) {
    const { summary } = await runBindings({ acceptanceCriteria: acs, headSha });
    const red = assertRedFirst(summary);
    if (!red.ok) {
      throw new Error(
        `retry-with-prior-work: ${red.reason} — a prior attempt's implementation is present; single-spawn will complete + the completion gate verifies`,
      );
    }
    const ownedTestFiles = [...new Set(
      priorBound
        .map((a) => String(a.testBinding.testRef).split(' > ')[0].trim())
        .filter((f) => TEST_FILE_RE.test(f)),
    )];
    log(`retry: ${acs.length} AC(s) already bound from a prior attempt — reusing committed tests (RED re-confirmed); owns ${ownedTestFiles.length} test file(s)`);
    return { ownedTestFiles, bindingOutput: '', redSha: headSha, boundCriteria: acs };
  }

  const { exitCode, text } = await spawnOnce({ prompt: buildStoryTestPrompt(payload) });
  if (exitCode !== 0) throw new Error(`test-author spawn exit ${exitCode}`);

  const manifest = parseBindingManifest(text || '');
  const boundCriteria = applyBindings(payload.acceptanceCriteria || [], manifest);
  if (!Object.keys(manifest).length) throw new Error('test-author emitted no <BINDING> manifest');

  // Commit the authored tests as the RED checkpoint (auditable + the SHA the
  // bindings run against).
  const commit = await commitRed({ label: `test(${payload.storyId}): RED` });
  const redSha = (commit && commit.sha) || headSha;
  const ownedTestFiles = (commit && commit.files) || [];

  // Prove RED: run the bound tests against the RED commit — they MUST all fail.
  const { summary } = await runBindings({ acceptanceCriteria: boundCriteria, headSha: redSha });
  const red = assertRedFirst(summary);
  if (!red.ok) throw new Error(`RED-first check failed: ${red.reason}`);
  log(`RED confirmed for ${payload.storyId}: ${red.reason}; owns ${ownedTestFiles.length} test file(s)`);

  return { ownedTestFiles, bindingOutput: text, redSha, boundCriteria };
}
