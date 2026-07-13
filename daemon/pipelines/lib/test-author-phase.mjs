// test-author-phase — W2.2 (P3_TEST_AUTHOR_SPLIT). The isolated Test-Author that
// precedes the Implementer, restoring the legacy test-first separation that P3
// collapsed. Kept in its own module (all primitives injected) so the live
// story-dev spawn loop is untouched and the default path is byte-identical.
//
// SAFETY: the caller runs this ONLY when P3_TEST_AUTHOR_SPLIT=on, and wraps it
// in try/catch → ONE retry → then the story FAILS CLOSED (pacman8 incident,
// 2026-07-11: the old fail-open fell back to the legacy single-spawn, letting
// the implementer author its own tests — the ONE forbidden mechanism in this
// pipeline). A throw here may cost the story, never the TDD separation.
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
/**
 * Split-path invariant-authoring block (Reality-Spine #6). PURE.
 * The single-story path renders its own equivalent (renderInvariantsBlock in
 * story-dev-pipeline.mjs); in the SPLIT path the TEST AUTHOR authors the
 * validators — its output becomes the story's devOutput, so the <INVARIANTS>
 * manifest must originate here or the gate never sees an authored validator and
 * fails the story closed. Steered to the `*.invariant.test.ts` form because the
 * RED commit only stages files matching TEST_FILE_RE (a `scripts/invariants/*.mjs`
 * validator would not be committed at RED and would be lost). Returns '' when the
 * story declares no invariants (byte-identical prompt for the common case).
 */
function renderTestAuthorInvariantsBlock(invariants) {
  if (!Array.isArray(invariants) || !invariants.length) return '';
  const declared = invariants
    .map((inv, i) => `  ${i + 1}. [${inv.id}] ${inv.description}`)
    .join('\n');
  const manifestFields = invariants
    .map((inv) => `"${inv.id}": { "ref": "<path-to-your-invariant-test>", "kind": "test" }`)
    .join(', ');
  return [
    ``,
    `# Invariant validators (MANDATORY — the gate executes these deterministically)`,
    `This story declares invariants: properties of the domain data/contract that MUST`,
    `hold. For EACH one below author an EXECUTABLE validator as a vitest file named`,
    `src/**/<id>.invariant.test.ts that imports the REAL module/data under test and`,
    `asserts the property. Use the *.invariant.test.ts form (NOT scripts/invariants/*.mjs)`,
    `so it is staged with your other RED tests. NEVER vi.mock(/jest.mock( an in-repo`,
    `module — a mocked validator proves nothing and the gate treats it as failing.`,
    `Like every test you author it MUST FAIL now (the contract/data does not exist yet).`,
    ``,
    `Declared invariants:`,
    declared,
    ``,
    `Emit a manifest mapping each invariant id to its authored validator file:`,
    `<INVARIANTS>`,
    `{ ${manifestFields} }`,
    `</INVARIANTS>`,
  ].join('\n');
}

export function buildStoryTestPrompt(payload) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => {
      const browser = ac.verify === 'behavior' || ac.needsBrowser === true;
      const tags = [
        ac.acClass ? ac.acClass : null,
        ac.verify ? `verify:${ac.verify}` : null,
        browser ? 'needsBrowser:true → bind testKind:browser (NO test file)' : null,
      ].filter(Boolean).join(', ');
      const probe = browser && (ac.when || ac.thenObservable)
        ? `\n     when: ${ac.when || '(unspecified)'} → thenObservable: ${ac.thenObservable || '(unspecified)'}`
        : '';
      return `  ${i + 1}. [${ac.id}] ${ac.text}${tags ? ` (${tags})` : ''}${probe}`;
    })
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
    `# Behavioral ACs are verified in the REAL app, not by a mocked test`,
    `- An AC marked verify:'behavior' / needsBrowser:true MUST be bound testKind:'browser'.`,
    `  Do NOT author a unit/integration test file for it — the browser probe executor`,
    `  drives the running app through window.__harness by reading that AC's`,
    `  when/thenObservable prose directly. Bind it { "testRef": "<its when/thenObservable`,
    `  intent>", "testKind": "browser" }; the completion gate REJECTS a 'unit'/'manual'`,
    `  binding for a behavioral AC (a mocked hook does not satisfy it).`,
    `- Author real failing unit tests ONLY for pure verify:'state'/'build' ACs on this`,
    `  slice. Never mock the app to fake a behavioral pass.`,
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
    renderTestAuthorInvariantsBlock(payload.invariants),
    ``,
    `# Required: bind each AC to its test — MACHINE-RUNNABLE selectors only`,
    `The completion gate RUNS each "testRef" verbatim as a vitest filter, so for a`,
    `file-bound (unit/integration) AC it MUST be exactly one of these three shapes —`,
    `nothing else:`,
    `  1. a single real test-file path you authored, e.g. "src/x/foo.test.ts";`,
    `  2. a single-test selector "src/x/foo.test.ts > describe name > it name";`,
    `  3. a JSON ARRAY of real test-file paths when ONE AC genuinely needs several`,
    `     files, e.g. ["src/x/a.test.ts", "src/x/b.test.ts"] — the gate runs each`,
    `     and the AC passes iff every file resolves and passes.`,
    `FORBIDDEN inside a testRef (they make it un-runnable → the gate can resolve no`,
    `file → the AC fails FOREVER even though your test files pass — this is the`,
    `Incident-C wall): prose or free-text descriptions, parenthetical annotations`,
    `like "(contract)"/"(typecheck)", phrases like "enforced separately by ...", and`,
    `" + "-joined strings that concatenate multiple files into one ref. If one AC`,
    `needs several files, use the ARRAY form (shape 3) — NEVER join paths with " + ".`,
    `(A behavioral/needsBrowser AC is the ONE exception: bind it testKind:'browser'`,
    `with its when/thenObservable intent as the testRef, per the rule above — never a`,
    `file path.)`,
    `<BINDING>`,
    `{ ${(payload.acceptanceCriteria || []).map((ac) => `"${ac.id}": { "testRef": "src/x/foo.test.ts  (or  \\"src/x/foo.test.ts > describe > it\\"  or  [\\"src/x/a.test.ts\\",\\"src/x/b.test.ts\\"])", "testKind": "unit|integration|browser|manual" }`).join(', ')} }`,
    `</BINDING>`,
  ].filter((l) => l !== '').join('\n');
}

/**
 * The Implementer prompt (split variant): tests already exist and are committed;
 * implement the minimum to GREEN and NEVER touch the authored tests. PURE.
 */
export function buildImplementerPrompt(payload, ownedTestFiles = [], testContents = {}) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}`)
    .join('\n');
  // Inline the authored tests (pacman1, 2026-07-13): they ARE the spec and are
  // known at spawn time — without this the implementer re-opened every test
  // file turn by turn on every attempt. The caller size-caps `testContents`;
  // files absent from the map stay list-only and are read from disk as before.
  const inlined = Object.entries(testContents || {});
  const inlinedBlock = inlined.length
    ? [
        ``,
        `# The authored tests, inline (identical to the committed files — implement against THESE; no need to re-open them):`,
        ...inlined.flatMap(([f, src]) => [`## ${f}`, '```', String(src), '```']),
      ]
    : [];
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
    ...inlinedBlock,
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
 * @returns {Promise<{ ownedTestFiles:string[], bindingOutput:string, redSha:string, boundCriteria:object[], resumed?:boolean }>}
 * @throws on any FRESH-path failure — the caller retries once, then fails the
 *   story CLOSED (never the legacy single-spawn; see the SAFETY note above).
 */
export async function runTestAuthorPhase({ payload, headSha, spawnOnce, commitRed, runBindings, logger }) {
  const log = (m) => { try { logger?.info?.(`[test-author] ${m}`); } catch { /* ignore */ } };

  // RETRY IDEMPOTENCY (pacman4 forensic, 2026-07-05 · fail-closed rework after
  // the pacman8 incident, 2026-07-11): a revived/retried story whose ACs are
  // ALREADY BOUND (a prior attempt authored + committed the RED tests) must NOT
  // re-author — the shared worktree may hold that attempt's leftover
  // implementation, so freshly-authored tests can pass immediately and the
  // RED-first gate rejects the whole phase (a wasted spawn + lost isolation).
  // Instead: RESUME with the committed tests, whether the bindings are all-RED
  // or partially GREEN. RED was already proven at the RED commit; on a retry
  // the correct move is fix-forward by the implementer against the SAME
  // immutable tests — the completion gate re-verifies every binding honestly
  // at the final SHA, so a partially-green resume can never fake a pass.
  // (The old code THREW 'retry-with-prior-work' on any GREEN binding, and the
  // caller's fail-open sent the story to the legacy single-spawn — the
  // implementer authored its own tests, the ONE forbidden mechanism here.)
  const acs = payload.acceptanceCriteria || [];
  const priorBound = acs.filter((a) => a?.testBinding?.testRef);
  if (acs.length > 0 && priorBound.length === acs.length) {
    // Re-run the bindings for telemetry only (all-RED vs prior work present) —
    // the outcome no longer gates the resume.
    const { summary } = await runBindings({ acceptanceCriteria: acs, headSha });
    const red = assertRedFirst(summary);
    const ownedTestFiles = [...new Set(
      priorBound
        .map((a) => String(a.testBinding.testRef).split(' > ')[0].trim())
        .filter((f) => TEST_FILE_RE.test(f)),
    )];
    log(`retry: ${acs.length} AC(s) already bound from a prior attempt — reusing committed tests (${red.ok ? 'RED re-confirmed' : `prior work present: ${red.reason} — implementer fixes forward`}); owns ${ownedTestFiles.length} test file(s)`);
    return { resumed: true, ownedTestFiles, bindingOutput: '', redSha: headSha, boundCriteria: acs };
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
  // BINDING-FAULT passthrough (Incident C / F3): assertRedFirst now REJECTS a
  // binding that ERRORED (a testRef that resolved to no real test file — an
  // un-runnable composite/prose ref) as a FAULT, distinct from a genuine RED. We
  // surface its reason verbatim and fail the FRESH phase closed — we do NOT
  // catch-and-swallow a binding fault as a normal RED failure, because an errored
  // binding is NOT proof of RED and would dead-end at completion (the composite-ref
  // wall). The caller retries once, then fails the story closed.
  const { summary } = await runBindings({ acceptanceCriteria: boundCriteria, headSha: redSha });
  const red = assertRedFirst(summary);
  if (!red.ok) throw new Error(`RED-first check failed: ${red.reason}`);
  log(`RED confirmed for ${payload.storyId}: ${red.reason}; owns ${ownedTestFiles.length} test file(s)`);

  return { ownedTestFiles, bindingOutput: text, redSha, boundCriteria };
}
