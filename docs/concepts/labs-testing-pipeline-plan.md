# Labs Testing Pipeline — Implementation Plan

**Date:** 2026-04-13
**Origin:** Party Mode discussion — Rick, Winston, Ludwig, Murat, Amelia, John, Bob, Dr. Quinn, Sally
**Status:** ALL PHASES (1-4) IMPLEMENTED (2026-04-13)

---

## Context & Problem

The Labs module runs an agentic workflow: PM generates epic/stories, Dev agents implement in parallel waves, Reviewer agents check code, PO does final review. The PO review is **code inspection only** — it never runs the app. This caused the SpyHunter bug: PO passed the review, but the game was visually broken (over-zoomed viewport, car not visible).

Beyond bugs, the current pipeline is greenfield-only. No support for bug fixes on existing apps, no feature additions, no testing beyond code review.

---

## Decisions Made

| Decision               | Chosen Approach                                                               | Rejected Alternative                                                   |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| AC type classification | Binary `needs_browser` flag per criterion                                     | 7-type taxonomy (too complex, LLM misclassification risk)              |
| Visual QA timing       | Once per epic after all stories done (consolidated)                           | Per-story Visual QA (overkill, misses integration bugs)                |
| Visual test storage    | DynamoDB entries in story records                                             | YAML files on EC2 filesystem (ephemeral, invisible to API)             |
| Epic format            | XML for agent wire format, UI renders structured editor                       | YAML/Markdown (less reliable parsing, ambiguous)                       |
| Epic statuses          | 6 generic: DRAFT, READY, IN_PROGRESS, IN_REVIEW, FIXING, COMPLETED + DEPLOYED | Status per review type (VISUAL_QA, etc. — too coupled)                 |
| Build/server checks    | Non-agentic shell steps in pipeline                                           | Agent-based checks (wasteful, slow)                                    |
| Test generation (v1)   | No agent-written unit tests yet                                               | Mandatory test writing (doubles dev time, low-quality tests from LLMs) |
| Session context        | Store session IDs + context digests in project registry                       | Discard sessions after pipeline completes                              |

---

## Implementation Phases

### Phase 1 — Shell Steps in Pipeline (Immediate, highest ROI)

**Goal:** Add non-agentic build and server health checks to every story pipeline. Zero LLM cost, ~10s added per story, catches build failures and runtime crashes automatically.

#### 1.1 Type Changes

**File:** `functions/shared/types/agent-orchestrator.ts`

Add `PipelineStepType` and shell-specific fields to `PipelineStep`:

```typescript
// ADD: Step type discriminator
export type PipelineStepType = 'agent' | 'shell';

// MODIFY: PipelineStep interface
export interface PipelineStep {
  id: string;
  stepType?: PipelineStepType; // NEW — default 'agent' for backward compat
  agentId?: string; // was implicitly required, now optional (shell steps)
  prompt?: string; // optional for shell steps

  // Agent-specific (existing, unchanged)
  resumeFromStep?: string;
  extractors?: Record<string, ExtractorConfig>;
  validations?: ValidationConfig[];
  loopTo?: string;

  // Shell-specific (NEW)
  command?: string; // bash command to execute
  timeout?: number; // ms, default 30000
  expectExitCode?: number; // default 0
  captureAs?: string; // store stdout in this variable name
  captureStderrAs?: string; // store stderr in this variable name
  onFail?: {
    action: 'fail' | 'retry_step';
    targetStep?: string;
    injectAs?: string; // variable name to inject error output into
  };
}
```

**Backward compatibility:** `stepType` defaults to `'agent'` when undefined. All existing pipelines work unchanged.

#### 1.2 Daemon Changes

**File:** `daemon/agent-daemon.mjs`

**Add new function** `executeShellStep()` — insert near line 428, before `executeStep()`:

```javascript
async function executeShellStep(jobId, step, workingDir, variables) {
  const command = substituteTemplate(step.command, variables);
  const timeout = step.timeout || 30000;
  const expectCode = step.expectExitCode ?? 0;

  log('info', `\n${'='.repeat(60)}`);
  log('info', `STEP: ${step.id} (Shell command)`);
  log('info', `${'='.repeat(60)}`);
  log('debug', `Command: ${command}`);

  await pushEvent(jobId, step.id, '__shell__', 'step_start', {
    text: `Shell: ${command.slice(0, 120)}`,
  });

  const startMs = Date.now();

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      cwd: workingDir || process.env.HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const passed = !killed && code === expectCode;

      if (step.captureAs) variables[step.captureAs] = stdout;
      if (step.captureStderrAs) variables[step.captureStderrAs] = stderr;

      const stepResult = {
        stepId: step.id,
        agentId: '__shell__',
        status: 'complete',
        cost: 0,
        durationMs,
        extractedVariables: {},
        validationResults: [
          {
            label: `exit code ${code}${killed ? ' (timeout)' : ''}`,
            passed,
            details: passed
              ? `Exited ${code} as expected`
              : `Expected ${expectCode}, got ${code}${killed ? ' (killed)' : ''}. stderr: ${stderr.slice(0, 300)}`,
          },
        ],
      };

      await pushEvent(jobId, step.id, '__shell__', passed ? 'step_complete' : 'step_error', {
        text: passed
          ? `Shell passed (${durationMs}ms)`
          : `Shell FAILED: exit ${code}. ${stderr.slice(0, 300)}`,
        durationMs,
      });

      if (!passed && step.onFail?.injectAs) {
        variables[step.onFail.injectAs] = stderr || stdout;
      }

      resolve({ passed, stepResult });
    });

    proc.on('error', async (err) => {
      clearTimeout(timer);
      await pushEvent(jobId, step.id, '__shell__', 'step_error', {
        text: `Shell spawn failed: ${err.message}`,
      });
      resolve({
        passed: false,
        stepResult: {
          stepId: step.id,
          agentId: '__shell__',
          status: 'error',
          cost: 0,
          durationMs: Date.now() - startMs,
          errorMessage: err.message,
          extractedVariables: {},
          validationResults: [],
        },
      });
    });
  });
}
```

**Modify `executeStep()`** — add branch at top (line 430):

```javascript
async function executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults) {
  // ── Branch on step type ──
  if (step.stepType === 'shell') {
    const { passed, stepResult } = await executeShellStep(jobId, step, workingDir, variables);
    stepResults.push(stepResult);
    await updateJobFields(jobId, { variables, sessions, stepResults });

    if (!passed && step.onFail?.action === 'fail') {
      throw new Error(`Shell step ${step.id} failed`);
    }

    return { allPassed: passed, stepResult };
  }

  // ── Existing agent logic (unchanged) ──
  const agent = agents[step.agentId];
  // ... rest unchanged ...
```

The existing `executePipeline()` loop at line 555 already handles `allPassed` and `loopTo` — shell steps integrate seamlessly with the retry mechanism.

#### 1.3 Pipeline Definition Changes

**File:** `functions/api/index.ts` — modify `generateStoryPipeline()` (line 484)

Insert two shell steps between DEV and REVIEWER:

```typescript
function generateStoryPipeline(
  story: EpicStory,
  epicTitle: string,
  workingDir: string,
  opts: { devModel?: string; devEffort?: string; reviewerModel?: string; reviewerEffort?: string },
): PipelineDefinition {
  return {
    maxIterations: 3,
    agents: {
      DEV: {
        name: 'Developer',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        model: opts.devModel || undefined,
      },
      REVIEWER: {
        name: 'Code Reviewer',
        allowedTools: 'Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
        model: opts.reviewerModel || undefined,
      },
    },
    steps: [
      // 1. Dev implements story
      {
        id: 'dev',
        agentId: 'DEV',
        prompt: `... (existing prompt unchanged) ...`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 2. NEW — Build check (shell, ~2-5s, $0)
      {
        id: 'build-check',
        stepType: 'shell',
        command: `cd ${workingDir} && npm run build 2>&1`,
        timeout: 30000,
        captureStderrAs: 'BUILD_OUTPUT',
        captureAs: 'BUILD_OUTPUT',
        onFail: { action: 'retry_step', targetStep: 'dev-build-fix', injectAs: 'BUILD_ERROR' },
        loopTo: 'dev-build-fix',
      },

      // 3. NEW — Build fix (loop-only, only runs if build fails)
      {
        id: 'dev-build-fix',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The build failed. Error output:

{{BUILD_ERROR}}

Fix ONLY the build error. Do not refactor or change anything else.
Then output:
---WORK_SUMMARY---
[What you fixed to resolve the build error]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 4. NEW — Server health check (shell, ~8s, $0)
      {
        id: 'server-check',
        stepType: 'shell',
        command: `cd ${workingDir} && (npm run dev -- --host 0.0.0.0 &); sleep 5; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); kill $(lsof -ti:5173) 2>/dev/null; [ "$STATUS" = "200" ]`,
        timeout: 15000,
        captureStderrAs: 'SERVER_ERROR',
        captureAs: 'SERVER_OUTPUT',
        onFail: { action: 'retry_step', targetStep: 'dev-server-fix', injectAs: 'SERVER_ERROR' },
        loopTo: 'dev-server-fix',
      },

      // 5. NEW — Server fix (loop-only, only runs if server check fails)
      {
        id: 'dev-server-fix',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The dev server failed to start or respond. Error:

{{SERVER_ERROR}}

Fix the issue so the app serves correctly on port 5173.
Then output:
---WORK_SUMMARY---
[What you fixed to resolve the server issue]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 6. Reviewer (existing, unchanged)
      {
        id: 'review',
        agentId: 'REVIEWER',
        prompt: `... (existing prompt unchanged) ...`,
        extractors: {
          /* unchanged */
        },
        validations: [
          { type: 'equals', left: 'VERDICT', right: 'PASS', label: 'Code review approved' },
        ],
        loopTo: 'retry',
      },

      // 7. Dev retry on review failure (existing, unchanged)
      {
        id: 'retry',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `... (existing prompt unchanged) ...`,
        extractors: {
          /* unchanged */
        },
        validations: [],
      },
    ],
  };
}
```

**New pipeline flow per story:**

```
DEV (write code)
  → build-check (shell, 2s, $0)
    → FAIL? → dev-build-fix (resume session) → build-check again (up to 3x)
  → server-check (shell, 8s, $0)
    → FAIL? → dev-server-fix (resume session) → server-check again (up to 3x)
  → REVIEWER (code review)
    → FAIL? → retry (resume session) → REVIEWER again (up to 3x)
```

#### 1.4 UI Updates for Shell Steps

**File:** `src/components/labs/agentic-workflow/story-card.tsx`

The story card currently shows phases like "Developing..." / "In Review..." / "Fixing..." based on the current pipeline step. Add awareness of shell steps:

- When current step is `build-check` → show "Building..." with a build icon
- When current step is `server-check` → show "Checking server..." with a health icon
- When current step is `dev-build-fix` or `dev-server-fix` → show "Fixing build..." / "Fixing server..."
- Shell step events (`__shell__` agentId) should render differently in the event log — show as system checks, not agent output

**File:** `src/components/agentic-office/event-translator.ts`

Add handling for `__shell__` agent events:

- `step_start` with `__shell__` → office action: worker walks to a "testing station" or stays at desk with a different emoji
- `step_complete` with `__shell__` → green checkmark milestone
- `step_error` with `__shell__` → red X milestone, worker moves to "fixing" mode

**File:** `src/types/agentic-office.ts`

Add to `WorkerRole`:

```typescript
export type WorkerRole = 'PM' | 'DEV' | 'REVIEWER' | 'PO' | 'DEPLOY' | 'QA';
```

The QA worker role will be used in Phase 2 for Visual QA but adding it now avoids a type change later.

#### 1.5 Verification Checklist

- [ ] Existing pipelines (no `stepType`) still work unchanged
- [ ] Shell step `build-check` catches a broken import and triggers `dev-build-fix`
- [ ] Shell step `server-check` catches a runtime crash and triggers `dev-server-fix`
- [ ] `dev-build-fix` resumes the original dev session (session ID reuse works)
- [ ] Shell step events appear in the UI event log
- [ ] Story card shows correct phase labels for shell steps
- [ ] Loop-only steps (`dev-build-fix`, `dev-server-fix`) are skipped in linear flow
- [ ] Cost tracking: shell steps report $0, don't inflate totals
- [ ] Agentic Office: shell events translate to appropriate office actions

---

### Phase 2 — Epic Status State Machine & `needs_browser` Flag

**Goal:** Expand epic/story statuses to support the full lifecycle (including review and fixing phases), and add the `needs_browser` classification to acceptance criteria.

#### 2.1 Status Changes

**File:** `src/types/epic-workflow.ts` + `functions/shared/types/epic-workflow.ts`

```typescript
// BEFORE:
export type EpicStatus = 'draft' | 'in_progress' | 'completed' | 'failed';
export type StoryStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

// AFTER:
export type EpicStatus =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'deployed';
export type StoryStatus =
  | 'pending'
  | 'running'
  | 'in_review'
  | 'fixing'
  | 'done'
  | 'failed'
  | 'skipped';
```

**State machines:**

```
Epic:   DRAFT → READY → IN_PROGRESS → IN_REVIEW → COMPLETED → DEPLOYED
                             ↑              │
                             └── FIXING ◄───┘

Story:  PENDING → RUNNING → IN_REVIEW → DONE
                      ↑          │
                      └── FIXING ◄┘
```

#### 2.2 EpicStory Structure Changes

**File:** `src/types/epic-workflow.ts` + `functions/shared/types/epic-workflow.ts`

```typescript
export interface AcceptanceCriterion {
  id: string; // e.g., "AC-1"
  text: string; // plain English description
  needsBrowser: boolean; // binary flag — does verification require a running browser?
}

export interface VisualTestDef {
  id: string; // e.g., "VT-S5-1"
  criteriaRef: string; // which AC this tests
  description: string; // what to verify
  setup: string; // how to get to the testable state
  action?: string; // user interaction to simulate (optional)
  expect: string; // what the result should look like
}

export interface EpicStory {
  storyId: string;
  order: number;
  title: string;
  description: string;
  status: StoryStatus;
  jobId?: string;
  dependsOn?: string[];
  wave?: number;
  hasBrowserTests?: boolean; // NEW — derived from criteria
  criteria?: AcceptanceCriterion[]; // NEW — structured criteria
  visualTests?: VisualTestDef[]; // NEW — populated by Dev agent
}
```

#### 2.3 EpicWorkflow Structure Changes

```typescript
export interface TestingProfile {
  hasBrowserTests: boolean;
  viewport?: string; // e.g., "800x600"
  interactionModel?: string; // e.g., "keyboard", "mouse", "touch"
}

export interface ReviewStep {
  step: string; // e.g., "visual_qa", "po_review"
  status: 'pending' | 'running' | 'passed' | 'failed';
  jobId?: string;
  completedAt?: string;
}

export interface EpicWorkflow {
  epicId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  workingDir: string;
  status: EpicStatus;
  stories: EpicStory[];
  testingProfile?: TestingProfile; // NEW
  reviewSteps?: ReviewStep[]; // NEW — dynamic review checklist
  // ... rest unchanged
}
```

#### 2.4 PM Prompt Changes

**File:** `functions/api/index.ts` — modify PM prompt (line 609)

Add to the PM agent's epic generation prompt:

```
8. For each acceptance criterion, decide: does verifying this require looking at a running browser?
   - needs_browser="true": visual appearance, layout, animations, user interactions, responsive behavior
   - needs_browser="false": code structure, API responses, data logic, build success, package installation

9. Add the needs_browser attribute to each criterion in the XML.

10. Add a <testing_profile> section to the epic:
    - has_browser_tests: true if ANY criterion across ANY story has needs_browser="true"
    - viewport: recommended viewport size (e.g., "800x600" for games, "1280x720" for web apps)
    - interaction_model: primary input method (keyboard, mouse, touch, or combination)
```

Updated XML format:

```xml
<epic>
  <title>...</title>
  <description>...</description>
  <testing_profile>
    <has_browser_tests>true</has_browser_tests>
    <viewport>800x600</viewport>
    <interaction_model>keyboard</interaction_model>
  </testing_profile>
  <acceptance_criteria>
    <criterion needs_browser="false">Overall criterion 1</criterion>
    <criterion needs_browser="true">Overall criterion 2</criterion>
  </acceptance_criteria>
  <stories>
    <story id="S1">
      <title>...</title>
      <depends_on></depends_on>
      <description>
        ...
        Acceptance Criteria:
        - [needs_browser=false] Project builds with tsc
        - [needs_browser=true] Empty canvas renders at 800x600
      </description>
    </story>
  </stories>
</epic>
```

#### 2.5 XML Parser Changes

**File:** `functions/api/index.ts` — modify `from-xml` endpoint (line 703)

Update the XML parser to extract:

- `testing_profile` from `<testing_profile>` element
- `needs_browser` attribute from criteria within story descriptions
- Compute `hasBrowserTests` per story (any criterion with `needs_browser=true`)
- Store structured `criteria[]` array per story in DynamoDB

#### 2.6 Reviewer Prompt Changes

Update the Reviewer prompt in `generateStoryPipeline()` to also check:

- If story has `needs_browser` criteria → verify Dev wrote visual test definitions
- Visual test definitions cover all `needs_browser=true` criteria
- Test descriptions are specific enough for automated verification

#### 2.7 UI Changes

**Epic info panel** (`src/components/labs/agentic-workflow/epic-info-panel.tsx`):

- Show `IN_REVIEW` status with dynamic review step progress
- Show `FIXING` status with per-story correction status
- Replace hardcoded "all stories done" checks with status-aware logic

**Story card** (`src/components/labs/agentic-workflow/story-card.tsx`):

- Show `needs_browser` badge on stories that have browser tests
- Show structured criteria list (expandable) instead of raw description
- Show visual test definitions when populated by Dev agent

**Project selector** (`src/components/labs/agentic-workflow/project-selector.tsx`):

- Update status badges for new statuses: READY, IN_REVIEW, FIXING, DEPLOYED

**Agentic Office Kanban** (`src/components/agentic-office/overlays/kanban-board.tsx`):

- Already has columns: backlog, in_progress, in_review, fixing, done — maps perfectly to new story statuses
- No structural changes needed, just ensure status mapping is correct

#### 2.8 Verification Checklist

- [ ] PM generates epic with `needs_browser` flags and `testing_profile`
- [ ] XML parser extracts and stores structured criteria
- [ ] New epic statuses render correctly in UI (all 7 + DEPLOYED)
- [ ] New story statuses render in story cards
- [ ] Kanban board columns map correctly to new story statuses
- [ ] Status transitions work: IN_PROGRESS → IN_REVIEW → FIXING → IN_REVIEW → COMPLETED
- [ ] Reviewer checks for visual test definitions on `needs_browser` stories

---

### Phase 3 — Visual QA Agent (Epic-Level Consolidated Testing)

**Goal:** After all stories complete, run a single Visual QA pass that executes all visual test definitions, reports per-test verdicts, and triggers targeted corrections.

#### 3.1 Visual QA Pipeline

New pipeline type for epic-level visual QA. Triggered when epic transitions from IN_PROGRESS → IN_REVIEW and `testingProfile.hasBrowserTests === true`.

**New API endpoint:** `POST /api/epic-workflows/:id/visual-qa`

Pipeline:

1. **Shell step:** Start dev server, wait for ready
2. **Agent step (Visual QA):**
   - Read all `visualTests` from DynamoDB across all stories
   - Generate Playwright script covering all tests
   - Execute script → capture screenshots per test ID
   - Send screenshots + expectations to vision model
   - Output structured verdicts per test
3. **Shell step:** Kill dev server

If failures found:

- Mark specific stories as FIXING
- Create correction jobs per story (targeted Dev fix pipelines)
- After corrections → re-run Visual QA on failed tests only

#### 3.2 Dev Agent Visual Test Output

Modify Dev agent prompt for stories with `hasBrowserTests: true`:

```
If this story has visual/browser criteria, also output visual test definitions:

---VISUAL_TESTS---
- id: VT-{storyId}-1
  criteriaRef: AC-1
  description: "What to verify visually"
  setup: "How to reach the testable state"
  action: "none | keypress:Space | click:.selector"
  expect: "What the correct result looks like"
---END_VISUAL_TESTS---
```

Add extractor for `VISUAL_TESTS` in pipeline definition. Parse YAML from extracted text, store as `visualTests[]` on the story record.

#### 3.3 Correction Loop

When Visual QA fails tests:

1. Group failures by story
2. Per story with failures:
   - Create correction job: Dev agent (resume original session) + Reviewer
   - Inject: failed test IDs, QA observations, screenshots (as descriptions)
3. After all corrections: re-run Visual QA on previously-failed tests only
4. Max 3 correction cycles

#### 3.4 Verification Checklist

- [ ] Dev agent produces visual test definitions for `hasBrowserTests` stories
- [ ] Visual test defs extracted and stored in DynamoDB
- [ ] Visual QA pipeline starts dev server, runs Playwright, captures screenshots
- [ ] Vision model evaluates screenshots against test expectations
- [ ] Failures grouped by story, correction jobs created
- [ ] Corrections use session resume for context continuity
- [ ] Re-run tests only for previously-failed tests
- [ ] Epic status: IN_REVIEW → FIXING → IN_REVIEW → COMPLETED

---

### Phase 4 — Project Registry & Brownfield Support

**Goal:** Enable bug fix and feature addition workflows on existing apps by tracking project state, session lineage, and file manifests.

#### 4.1 Project Registry Table

**New DynamoDB table:** `futurator-project-registry`

```typescript
interface ProjectRegistry {
  projectId: string; // PK — e.g., "spyhunter"
  name: string;
  ec2Path: string; // /home/ubuntu/projects/spyhunter
  epics: string[]; // ordered epic IDs
  currentStatus: 'draft' | 'active' | 'published';
  deployUrl?: string;
  sessions: Record<
    string,
    {
      // storyId → session metadata
      sessionId: string;
      filesCreated: string[];
      filesMutated: string[];
      contextDigest: string;
      completedAt: string;
    }
  >;
  fileManifest: Record<
    string,
    {
      // filePath → metadata
      createdByStory: string;
      lastMutatedByStory: string;
      lastSessionId: string;
    }
  >;
  createdAt: string;
  updatedAt: string;
}
```

#### 4.2 Session Capture

After each story completes, extract from the agent job:

- `sessionId` from `sessions['dev']`
- `filesCreated` / `filesMutated` from tool_use events (filter Write/Edit tools)
- `contextDigest` — generate by asking the session for a summary, or extract from WORK_SUMMARY

Store in project registry. Build file manifest incrementally.

#### 4.3 Bug Report Flow

**New API endpoint:** `POST /api/epic-workflows/:projectId/bug-report`

Input: `{ description: string, screenshot?: string }`

Pipeline:

1. **Bug Triage Agent:** Reads project registry → identifies affected files and stories → generates single fix story with criteria
2. **Dev Fix:** Resume best matching session or inject context digest → fix the bug
3. **Build check + server check** (shell steps)
4. **Reviewer:** Check fix addresses the bug report
5. **Visual QA** (if `needs_browser` criteria)
6. Deploy patch

#### 4.4 Feature Request Flow

**New API endpoint:** `POST /api/epic-workflows/:projectId/feature-request`

Input: `{ description: string }`

Pipeline:

1. **PM Agent:** Reads existing code context from project registry + new feature request → generates delta epic (only new/modified stories)
2. Standard build pipeline (dev → shell checks → reviewer per story)
3. Visual QA if applicable
4. PO review
5. Deploy

#### 4.5 Verification Checklist

- [ ] Project registry created on first epic deploy
- [ ] Session metadata captured and stored per story
- [ ] File manifest built incrementally from tool_use events
- [ ] Bug report flow: triage → fix → check → verify
- [ ] Feature request flow: PM delta → build → review → verify
- [ ] Session resume works for bug fixes (context recovery)
- [ ] Context digest fallback works when session expired

---

## Summary: Estimated Impact

| Phase                     | Files Changed      | New Code   | LLM Cost Impact           | Time Impact per Story            |
| ------------------------- | ------------------ | ---------- | ------------------------- | -------------------------------- |
| 1. Shell Steps            | 3 files            | ~120 lines | $0.00                     | +10s                             |
| 2. Status + needs_browser | ~8 files           | ~200 lines | ~$0.01 (richer PM prompt) | +0s                              |
| 3. Visual QA              | ~5 files           | ~300 lines | ~$0.05-0.10 per epic      | +30-60s per epic (not per story) |
| 4. Project Registry       | ~6 files + 1 table | ~400 lines | $0.00 (metadata only)     | +0s                              |

**Phase 1 is the immediate priority.** It's the highest ROI change — catches the majority of build/runtime bugs at zero LLM cost with minimal code changes.

---

## Tracking

If implementation fails at any phase, the phases are independent enough to resume from the last completed phase. Each phase has a verification checklist. Mark items as completed during implementation.

**Resume instructions:** Read this document, check which phase/step was last completed, continue from the next unchecked item. All code changes reference exact file paths and line numbers from the codebase as of 2026-04-13.
