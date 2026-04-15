'use client';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeEditor } from './code-editor';
import type {
  CreateAgentJobInput,
  PipelineDefinition,
  AgentConfig,
  PipelineStep,
  ExtractorConfig,
  ValidationConfig,
} from '@/types/agent-orchestrator';

interface PipelineEditorProps {
  onSubmit: (input: CreateAgentJobInput) => void;
  isLoading: boolean;
}

function makeDefaultPipeline(): PipelineDefinition {
  return {
    agents: {
      A: { name: 'Builder', allowedTools: 'Bash,Read,Edit,Write' },
      B: {
        name: 'Reviewer',
        allowedTools: 'Bash(git*),Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
      },
    },
    steps: [{ id: 'a1', agentId: 'A', prompt: '', extractors: {}, validations: [] }],
  };
}

function makeRoundtripExample(): PipelineDefinition {
  return {
    agents: {
      A: { name: 'Builder', allowedTools: 'Bash,Read,Edit,Write' },
      B: {
        name: 'Reviewer',
        allowedTools: 'Bash(git*),Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
      },
    },
    steps: [
      {
        id: 'a1',
        agentId: 'A',
        prompt: `You are Agent A. Follow these instructions EXACTLY.

1. Generate a random 6-digit SECRET TOKEN. This is YOUR secret.
   You must REMEMBER this token. It will NOT be shared with anyone.
   Say: MY SECRET TOKEN (do not share): SECRET_TOKEN: [your 6-digit number]

2. Generate a DIFFERENT random 4-digit PUBLIC TOKEN.
   This one WILL be shared with Agent B.
   Say: PUBLIC_TOKEN: [your 4-digit number]

3. Create a task for Agent B:
   "Count the consonants in the word ORCHESTRATION and report back."

4. End with this EXACT format (plain text, no markdown):
   ---HANDOFF_TO_B---
   PUBLIC_TOKEN: [your 4-digit public token]
   TASK: Count the consonants in the word ORCHESTRATION and report back.
   ---END_HANDOFF---

IMPORTANT: Do NOT include your secret token in the handoff block.
The secret token must only appear earlier in your message.
Keep your total response under 10 lines.`,
        extractors: {
          SECRET_TOKEN: { type: 'regex', pattern: 'SECRET_TOKEN:\\s*(\\d{6})' },
          PUBLIC_TOKEN: { type: 'regex', pattern: 'PUBLIC_TOKEN:\\s*(\\d{4})' },
          HANDOFF: {
            type: 'between',
            startDelimiter: '---HANDOFF_TO_B---',
            endDelimiter: '---END_HANDOFF---',
          },
        },
        validations: [],
      },
      {
        id: 'b1',
        agentId: 'B',
        prompt: `You are Agent B. You are a completely independent agent.

You received this handoff from Agent A:

{{HANDOFF}}

Do the following:

1. Acknowledge the PUBLIC TOKEN you received from Agent A.

2. Complete the task: Count the consonants in ORCHESTRATION.
   Show your work — go letter by letter.

3. Generate your own random 5-digit PROOF TOKEN.

4. End with this EXACT format (plain text, no markdown):
   ---REPORT_TO_A---
   PUBLIC_TOKEN_RECEIVED: [the public token A gave you]
   TASK_RESULT: [your consonant count with the letters listed]
   B_PROOF_TOKEN: [your 5-digit number]
   ---END_REPORT---

Keep your total response under 15 lines.`,
        extractors: {
          REPORT: {
            type: 'between',
            startDelimiter: '---REPORT_TO_A---',
            endDelimiter: '---END_REPORT---',
          },
          B_PROOF_TOKEN: { type: 'regex', pattern: 'B_PROOF_TOKEN:\\s*(\\d{5})' },
        },
        validations: [
          {
            type: 'not_contains',
            left: 'HANDOFF',
            right: 'SECRET_TOKEN',
            label: 'Secret isolation',
          },
        ],
      },
      {
        id: 'a2',
        agentId: 'A',
        resumeFromStep: 'a1',
        prompt: `Agent B has completed their work. Here is their full report:

{{REPORT}}

Now do the following:

1. What was YOUR SECRET TOKEN from the beginning of this session?
   You generated it earlier and were told not to share it.
   State it now as: RECALLED_SECRET: [your 6-digit token]

2. What PUBLIC TOKEN did you give to Agent B?
   Did Agent B report it back correctly?

3. Is Agent B's consonant count for ORCHESTRATION correct?

4. Acknowledge Agent B's proof token.

5. Give a verdict: PASS or FAIL for each:
   - SECRET_RECALL: PASS/FAIL
   - PUBLIC_MATCH: PASS/FAIL
   - TASK_CORRECT: PASS/FAIL
   - OVERALL: PASS only if all three pass`,
        extractors: {
          RECALLED_SECRET: { type: 'regex', pattern: 'RECALLED_SECRET:\\s*(\\d{6})' },
        },
        validations: [
          {
            type: 'equals',
            left: 'RECALLED_SECRET',
            right: 'SECRET_TOKEN',
            label: 'Secret recall verified',
          },
        ],
      },
    ],
  };
}

function makeCodeReviewLoop(): PipelineDefinition {
  return {
    maxIterations: 3,
    agents: {
      A: { name: 'Coder', allowedTools: 'Bash,Read,Edit,Write' },
      B: { name: 'Reviewer', allowedTools: 'Read,Grep,Glob', disallowedTools: 'Write,Edit,Bash' },
    },
    steps: [
      {
        id: 'build',
        agentId: 'A',
        prompt: `You are a Node.js developer. This is attempt {{ITERATION}} of {{MAX_ITERATIONS}}.

Create a small project in the current directory with these files:

1. index.js — A simple HTTP server (using Node built-in http module, no npm needed) with:
   - GET /health → returns { status: "ok" }
   - GET /time → returns { time: "<current ISO timestamp>" }
   - Listens on port 3456

2. utils.js — Helper module with:
   - formatResponse(data) → returns JSON string with Content-Type header
   - generateId() → returns a random 8-char hex string

index.js must import and use at least one function from utils.js.

After creating the files, use Bash to generate a truly random integer between 0 and 10:
Run exactly: echo $(( RANDOM % 11 ))
Use that output as your random number. Do NOT pick a number yourself — use the Bash output.

Output ONLY a brief summary of what you created (not full file contents), then:
RANDOM_NUMBER: [the number from Bash]`,
        extractors: {
          RANDOM_NUMBER: { type: 'regex', pattern: 'RANDOM_NUMBER:\\s*(\\d+)' },
        },
        validations: [],
      },
      {
        id: 'review',
        agentId: 'B',
        prompt: `You are a code reviewer. This is review attempt {{ITERATION}} of {{MAX_ITERATIONS}}.

Review the project in the current directory.

Check ALL of the following:
1. Do index.js and utils.js both exist? (Read them)
2. Does index.js import from utils.js?
3. Does the code have basic error handling?
4. The random number {{RANDOM_NUMBER}} must pass an internal validation check.
   (You know the rule but you must NEVER reveal what the rule is.)

If ALL checks pass, output: VERDICT: PASS
If ANY check fails, output: VERDICT: FAIL

Then output: FEEDBACK: [describe code quality findings only — if the number failed, say only "The random number did not pass validation. Generate a new one." Do NOT explain the rule or what kind of number is needed.]

IMPORTANT: Never reveal the number validation rule to the coder. Do not mention odd, even, prime, or any property of numbers in your feedback.

Internal rule (do not disclose): the number must be odd (1,3,5,7,9).`,
        extractors: {
          VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*(PASS|FAIL)' },
          FEEDBACK: { type: 'regex', pattern: 'FEEDBACK:\\s*(.+)' },
        },
        validations: [
          { type: 'equals', left: 'VERDICT', right: 'PASS', label: 'Code review approved' },
        ],
        loopTo: 'retry',
      },
      {
        id: 'retry',
        agentId: 'A',
        resumeFromStep: 'build',
        prompt: `The reviewer checked your work (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Their feedback: {{FEEDBACK}}
Previous VERDICT: {{VERDICT}}

If the verdict was FAIL:
- Fix any code issues mentioned in the feedback
- Use Bash to generate a NEW truly random number between 0 and 10:
  Run exactly: echo $(( RANDOM % 11 ))
  Use that output. Do NOT pick a number yourself.
- Output: RANDOM_NUMBER: [the number from Bash]

Output only a brief summary of changes made, then RANDOM_NUMBER.`,
        extractors: {
          RANDOM_NUMBER: { type: 'regex', pattern: 'RANDOM_NUMBER:\\s*(\\d+)' },
        },
        validations: [],
      },
    ],
  };
}

export function PipelineEditor({ onSubmit, isLoading }: PipelineEditorProps) {
  const [workingDir, setWorkingDir] = useState('');
  const [pipeline, setPipeline] = useState<PipelineDefinition>(makeDefaultPipeline);
  const [expandedStep, setExpandedStep] = useState<string | null>('a1');

  const updateStep = (stepId: string, patch: Partial<PipelineStep>) => {
    setPipeline((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
  };

  const addStep = () => {
    const idx = pipeline.steps.length + 1;
    const id = `step${idx}`;
    const agentIds = Object.keys(pipeline.agents);
    setPipeline((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        { id, agentId: agentIds[0] || 'A', prompt: '', extractors: {}, validations: [] },
      ],
    }));
    setExpandedStep(id);
  };

  const removeStep = (stepId: string) => {
    setPipeline((prev) => ({
      ...prev,
      steps: prev.steps.filter((s) => s.id !== stepId),
    }));
  };

  const updateAgent = (agentId: string, patch: Partial<AgentConfig>) => {
    setPipeline((prev) => ({
      ...prev,
      agents: { ...prev.agents, [agentId]: { ...prev.agents[agentId], ...patch } },
    }));
  };

  const addAgent = () => {
    const letters = 'ABCDEFGH';
    const existing = Object.keys(pipeline.agents);
    const next =
      letters.split('').find((l) => !existing.includes(l)) || `Agent${existing.length + 1}`;
    setPipeline((prev) => ({
      ...prev,
      agents: { ...prev.agents, [next]: { name: `Agent ${next}`, allowedTools: 'Bash,Read' } },
    }));
  };

  const removeAgent = (agentId: string) => {
    setPipeline((prev) => {
      const agents = Object.fromEntries(Object.entries(prev.agents).filter(([k]) => k !== agentId));
      return { ...prev, agents };
    });
  };

  const addExtractor = (stepId: string) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    const name = `VAR_${Object.keys(step.extractors || {}).length + 1}`;
    updateStep(stepId, {
      extractors: { ...step.extractors, [name]: { type: 'regex', pattern: '' } },
    });
  };

  const updateExtractor = (
    stepId: string,
    oldName: string,
    newName: string,
    config: ExtractorConfig,
  ) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    const extractors = { ...step.extractors };
    if (oldName !== newName) delete extractors[oldName];
    extractors[newName] = config;
    updateStep(stepId, { extractors });
  };

  const removeExtractor = (stepId: string, name: string) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    const extractors = Object.fromEntries(
      Object.entries(step.extractors || {}).filter(([k]) => k !== name),
    );
    updateStep(stepId, { extractors });
  };

  const addValidation = (stepId: string) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    updateStep(stepId, {
      validations: [
        ...(step.validations || []),
        { type: 'not_contains', left: '', right: '', label: '' },
      ],
    });
  };

  const updateValidation = (stepId: string, idx: number, v: ValidationConfig) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    const validations = [...(step.validations || [])];
    validations[idx] = v;
    updateStep(stepId, { validations });
  };

  const removeValidation = (stepId: string, idx: number) => {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;
    updateStep(stepId, {
      validations: (step.validations || []).filter((_, i) => i !== idx),
    });
  };

  const loadExample = () => {
    setPipeline(makeRoundtripExample());
    setExpandedStep('a1');
  };

  const loadCodeReview = () => {
    setPipeline(makeCodeReviewLoop());
    setExpandedStep('build');
  };

  const canSubmit =
    workingDir.trim() &&
    pipeline.steps.length > 0 &&
    pipeline.steps.every((s) => s.stepType === 'shell' || s.prompt?.trim());

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    console.log('[Labs] Submitting pipeline:', {
      workingDir,
      steps: pipeline.steps.length,
      agents: Object.keys(pipeline.agents),
    });
    onSubmit({ workingDir: workingDir.trim(), pipeline });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Quick load */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadExample}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Example 1: Agent Roundtrip Test
        </button>
        <button
          type="button"
          onClick={loadCodeReview}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Example 2: Code Review Loop
        </button>
        <span className="text-[10px] text-muted-foreground">
          Ex1: token isolation proof | Ex2: real code generation + review loop with odd-number gate
        </span>
      </div>

      {/* Agents config */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Agents</CardTitle>
            <button
              type="button"
              onClick={addAgent}
              className="text-xs text-primary hover:underline"
            >
              + Add Agent
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Object.entries(pipeline.agents).map(([id, agent]) => (
              <div key={id} className="rounded-md border border-input p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold">{id}</span>
                  {Object.keys(pipeline.agents).length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeAgent(id)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={agent.name}
                  onChange={(e) => updateAgent(id, { name: e.target.value })}
                  placeholder="Agent name"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                />
                <input
                  type="text"
                  value={agent.allowedTools || ''}
                  onChange={(e) => updateAgent(id, { allowedTools: e.target.value })}
                  placeholder="Allowed tools"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                />
                <input
                  type="text"
                  value={agent.disallowedTools || ''}
                  onChange={(e) => updateAgent(id, { disallowedTools: e.target.value })}
                  placeholder="Disallowed tools"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                />
                <select
                  value={agent.model || ''}
                  onChange={(e) => updateAgent(id, { model: e.target.value || undefined })}
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                >
                  <option value="">Model: default (opus)</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      {pipeline.steps.map((step, idx) => {
        const isExpanded = expandedStep === step.id;
        return (
          <Card key={step.id}>
            <CardHeader
              className="pb-2 cursor-pointer"
              onClick={() => setExpandedStep(isExpanded ? null : step.id)}
            >
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">
                  Step {idx + 1}: <span className="font-mono">{step.id}</span>
                  <span className="ml-2 text-muted-foreground font-normal">
                    (
                    {step.stepType === 'shell'
                      ? 'Shell'
                      : `Agent ${step.agentId} — ${step.agentId ? pipeline.agents[step.agentId]?.name : ''}`}
                    )
                  </span>
                  {step.resumeFromStep && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                      resume:{step.resumeFromStep}
                    </span>
                  )}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {pipeline.steps.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeStep(step.id);
                      }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                  <span className="text-muted-foreground">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
              </div>
            </CardHeader>
            {isExpanded && (
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Step ID</label>
                    <input
                      type="text"
                      value={step.id}
                      onChange={(e) => updateStep(step.id, { id: e.target.value })}
                      className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Agent</label>
                    <select
                      value={step.agentId}
                      onChange={(e) => updateStep(step.id, { agentId: e.target.value })}
                      className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                    >
                      {Object.keys(pipeline.agents).map((id) => (
                        <option key={id} value={id}>
                          {id} — {pipeline.agents[id].name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Resume from step
                    </label>
                    <select
                      value={step.resumeFromStep || ''}
                      onChange={(e) =>
                        updateStep(step.id, { resumeFromStep: e.target.value || undefined })
                      }
                      className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                    >
                      <option value="">None (fresh session)</option>
                      {pipeline.steps
                        .filter((s) => s.id !== step.id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.id}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Loop to (on validation fail)
                    </label>
                    <select
                      value={step.loopTo || ''}
                      onChange={(e) => updateStep(step.id, { loopTo: e.target.value || undefined })}
                      className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                    >
                      <option value="">None (continue)</option>
                      {pipeline.steps
                        .filter((s) => s.id !== step.id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.id}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Prompt{' '}
                    <span className="text-muted-foreground/60">
                      (use {'{{VAR_NAME}}'} for template substitution)
                    </span>
                  </label>
                  <CodeEditor
                    value={step.prompt ?? ''}
                    onChange={(v) => updateStep(step.id, { prompt: v })}
                    placeholder="Write instructions for this step..."
                    minHeight="140px"
                  />
                </div>

                {/* Extractors */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Extractors</label>
                    <button
                      type="button"
                      onClick={() => addExtractor(step.id)}
                      className="text-xs text-primary hover:underline"
                    >
                      + Add
                    </button>
                  </div>
                  {Object.entries(step.extractors || {}).map(([name, config]) => (
                    <div key={name} className="mb-2 flex items-start gap-2">
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => updateExtractor(step.id, name, e.target.value, config)}
                        placeholder="VAR_NAME"
                        className="w-32 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                      />
                      <select
                        value={config.type}
                        onChange={(e) =>
                          updateExtractor(step.id, name, name, {
                            ...config,
                            type: e.target.value as 'regex' | 'between',
                          })
                        }
                        className="rounded border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="regex">regex</option>
                        <option value="between">between</option>
                      </select>
                      {config.type === 'regex' ? (
                        <input
                          type="text"
                          value={config.pattern || ''}
                          onChange={(e) =>
                            updateExtractor(step.id, name, name, {
                              ...config,
                              pattern: e.target.value,
                            })
                          }
                          placeholder="regex pattern (capture group 1)"
                          className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                        />
                      ) : (
                        <div className="flex flex-1 gap-1">
                          <input
                            type="text"
                            value={config.startDelimiter || ''}
                            onChange={(e) =>
                              updateExtractor(step.id, name, name, {
                                ...config,
                                startDelimiter: e.target.value,
                              })
                            }
                            placeholder="Start delimiter"
                            className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                          />
                          <input
                            type="text"
                            value={config.endDelimiter || ''}
                            onChange={(e) =>
                              updateExtractor(step.id, name, name, {
                                ...config,
                                endDelimiter: e.target.value,
                              })
                            }
                            placeholder="End delimiter"
                            className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                          />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeExtractor(step.id, name)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>

                {/* Validations */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Validations</label>
                    <button
                      type="button"
                      onClick={() => addValidation(step.id)}
                      className="text-xs text-primary hover:underline"
                    >
                      + Add
                    </button>
                  </div>
                  {(step.validations || []).map((v, vi) => (
                    <div key={vi} className="mb-2 flex items-center gap-2">
                      <input
                        type="text"
                        value={v.label}
                        onChange={(e) =>
                          updateValidation(step.id, vi, { ...v, label: e.target.value })
                        }
                        placeholder="Label"
                        className="w-36 rounded border border-input bg-background px-2 py-1 text-xs"
                      />
                      <input
                        type="text"
                        value={v.left}
                        onChange={(e) =>
                          updateValidation(step.id, vi, { ...v, left: e.target.value })
                        }
                        placeholder="Left var"
                        className="w-28 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                      />
                      <select
                        value={v.type}
                        onChange={(e) =>
                          updateValidation(step.id, vi, {
                            ...v,
                            type: e.target.value as 'equals' | 'not_contains' | 'contains',
                          })
                        }
                        className="rounded border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="equals">==</option>
                        <option value="contains">contains</option>
                        <option value="not_contains">not contains</option>
                      </select>
                      <input
                        type="text"
                        value={v.right}
                        onChange={(e) =>
                          updateValidation(step.id, vi, { ...v, right: e.target.value })
                        }
                        placeholder="Right var"
                        className="w-28 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => removeValidation(step.id, vi)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}

      <button
        type="button"
        onClick={addStep}
        className="w-full rounded-md border border-dashed border-input py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary"
      >
        + Add Step
      </button>

      {/* Working dir + submit */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[280px]">
              <label className="mb-1 block text-sm font-medium text-muted-foreground">
                Working Directory
              </label>
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="/Users/you/projects/my-project"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !canSubmit}
              className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Running...' : `Run Pipeline (${pipeline.steps.length} steps)`}
            </button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
