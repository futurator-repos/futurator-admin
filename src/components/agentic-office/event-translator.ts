import type {
  AgentEvent,
  OrchestratorEvent,
  OrchestratorRole,
} from '@/types/agent-orchestrator';
import type { CharacterId, OfficeAction, PersonaRole } from './types';
import type { OrchestratorAnimationIntent } from './orchestrator-scene-state';

// Re-export the intent/status types so consumers don't need two imports.
export type { OrchestratorAnimationIntent, SupervisorStatus } from './orchestrator-scene-state';

// ── Translation context ──
// Tracker code knows which persona owns which story — the translator just
// emits actions scoped to that persona. `role` is included so the translator
// can emit role-appropriate phrasing.

export interface TranslationContext {
  characterId: CharacterId;
  role: PersonaRole;
  epicId: string;
  storyId: string;
  storyTitle: string;
}

// ── Helpers ──

function parseToolInput(input?: string): string {
  if (!input) return '';
  try {
    const parsed = JSON.parse(input);
    return parsed.file_path || parsed.command || parsed.pattern || parsed.path || '';
  } catch {
    return input.slice(0, 80);
  }
}

/** Secondary Task-tool fields — subagent_type + description. */
function parseTaskTool(input?: string): { subagentType?: string; description?: string } {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    return {
      subagentType: parsed.subagent_type,
      description: parsed.description,
    };
  } catch {
    return {};
  }
}

function isTestFile(path: string): boolean {
  return /\.test\.(ts|tsx|js|jsx|mjs)$|\/__tests__\/|\/e2e\/|\/tests\//.test(path);
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function truncateCommand(cmd: string): string {
  if (cmd.length > 40) return cmd.slice(0, 37) + '...';
  return cmd;
}

function classifyBashCommand(cmd: string): { emoji: string; message: string } {
  const lower = cmd.toLowerCase();
  if (
    lower.includes('npx vitest') ||
    lower.includes('vitest run') ||
    lower.includes('vitest ') ||
    lower.includes('npm test') ||
    lower.includes('npm run test') ||
    lower.includes('jest')
  ) {
    return { emoji: '🧪', message: 'Running tests...' };
  }
  if (lower.includes('npx playwright') || lower.includes('playwright test')) {
    return { emoji: '🎭', message: 'Running Playwright e2e...' };
  }
  if (
    lower.includes('npm run build') ||
    lower.includes('vite build') ||
    lower.includes('next build')
  ) {
    return { emoji: '🔨', message: 'Building the project...' };
  }
  if (lower.includes('npm install') || lower.includes('npm i ')) {
    return { emoji: '📦', message: 'Installing dependencies...' };
  }
  if (lower.includes('npm run lint') || lower.includes('eslint')) {
    return { emoji: '🔎', message: 'Running linter...' };
  }
  if (lower.includes('npm run dev') || lower.includes('npm start')) {
    return { emoji: '🚀', message: 'Starting dev server...' };
  }
  if (lower.startsWith('tree ') || lower.startsWith('find ') || lower.startsWith('ls ')) {
    return { emoji: '📂', message: 'Exploring files...' };
  }
  if (lower.startsWith('cat ') || lower.startsWith('head ') || lower.startsWith('tail ')) {
    return { emoji: '📄', message: 'Reading a file...' };
  }
  if (lower.includes('git ')) {
    return { emoji: '📋', message: 'Running git command...' };
  }
  if (lower.includes('aws ') || lower.includes('s3 ')) {
    return { emoji: '☁️', message: 'Running cloud command...' };
  }
  return { emoji: '⚡', message: `Running: ${truncateCommand(cmd)}` };
}

// ── Per-agent event translator ──
// Turns a single AgentEvent into zero or more OfficeActions against the
// persona named in ctx.characterId. Empty array = ignore.

export function translateEvent(event: AgentEvent, ctx: TranslationContext): OfficeAction[] {
  const ts = Date.now();
  const actions: OfficeAction[] = [];

  switch (event.eventType) {
    case 'step_start': {
      const agentId = event.agentId?.toUpperCase();
      if (agentId === '__SHELL__') {
        const stepId = event.stepId;
        const isBuilding = stepId === 'build-check';
        const isServer = stepId === 'server-check';
        const isTestVerify = stepId === 'test-verify';
        const isTestGateRed = stepId === 'test-gate-red';
        const isTamper = stepId === 'tamper-check';
        actions.push({
          type: 'chat',
          characterId: ctx.characterId,
          message: isBuilding
            ? 'Running build...'
            : isServer
              ? 'Checking server...'
              : isTestVerify
                ? 'Running tests...'
                : isTestGateRed
                  ? 'Verifying tests fail first...'
                  : isTamper
                    ? 'Scanning for tamper...'
                    : 'Running check...',
          emoji: isBuilding
            ? '🔨'
            : isServer
              ? '🌐'
              : isTestVerify
                ? '✅'
                : isTestGateRed
                  ? '🚦'
                  : isTamper
                    ? '🔎'
                    : '⚡',
          timestamp: ts,
        });
      } else if (agentId === 'DEV') {
        actions.push({
          type: 'chat',
          characterId: ctx.characterId,
          message: `Starting on ${ctx.storyTitle}`,
          emoji: '💪',
          timestamp: ts,
        });
      } else if (agentId === 'REVIEWER') {
        actions.push({
          type: 'chat',
          characterId: ctx.characterId,
          message: 'Reviewing the code...',
          emoji: '👀',
          timestamp: ts,
        });
      } else if (agentId === 'TEST') {
        const stepId = event.stepId;
        const msg =
          stepId === 'test-author'
            ? 'Writing tests...'
            : stepId === 'test-verify'
              ? 'Checking tests pass...'
              : stepId === 'tamper-check'
                ? 'Scanning for tamper...'
                : 'Running tests...';
        actions.push({
          type: 'chat',
          characterId: ctx.characterId,
          message: msg,
          emoji: '🧪',
          timestamp: ts,
        });
      }
      break;
    }

    case 'tool_use': {
      const toolName = event.toolName ?? '';
      const input = parseToolInput(event.toolInput);

      switch (toolName) {
        case 'Read':
        case 'Grep':
        case 'Glob':
          actions.push({
            type: 'chat',
            characterId: ctx.characterId,
            message: input ? `Looking at ${basename(input)}` : 'Reading files...',
            emoji: '🔍',
            tier: 'action',
            toolKind: 'read',
            timestamp: ts,
          });
          break;
        case 'Edit':
          actions.push({
            type: 'chat',
            characterId: ctx.characterId,
            message: input
              ? isTestFile(input)
                ? `Updating test: ${basename(input)}`
                : `Editing ${basename(input)}`
              : 'Editing code...',
            emoji: input && isTestFile(input) ? '🧪' : '✏️',
            tier: 'action',
            toolKind: 'edit',
            timestamp: ts,
          });
          break;
        case 'Write':
          actions.push({
            type: 'chat',
            characterId: ctx.characterId,
            message: input
              ? isTestFile(input)
                ? `Writing test: ${basename(input)}`
                : `Creating ${basename(input)}`
              : 'Writing new file...',
            emoji: input && isTestFile(input) ? '🧪' : '📝',
            tier: 'action',
            toolKind: 'write',
            timestamp: ts,
          });
          break;
        case 'Task': {
          const t = parseTaskTool(event.toolInput);
          const label = t.description
            ? t.description.length > 42
              ? `${t.description.slice(0, 40)}…`
              : t.description
            : t.subagentType
              ? `Dispatching ${t.subagentType}…`
              : 'Dispatching subagent…';
          actions.push({
            type: 'chat',
            characterId: ctx.characterId,
            message: label,
            emoji: '🤖',
            tier: 'action',
            toolKind: 'other',
            timestamp: ts,
          });
          break;
        }
        case 'Bash': {
          const { emoji, message } = classifyBashCommand(input);
          actions.push({
            type: 'chat',
            characterId: ctx.characterId,
            message,
            emoji,
            tier: 'action',
            toolKind: 'bash',
            timestamp: ts,
          });
          break;
        }
        default:
          if (toolName) {
            actions.push({
              type: 'chat',
              characterId: ctx.characterId,
              message: `Using ${toolName}...`,
              emoji: '🔧',
              tier: 'action',
              toolKind: 'other',
              timestamp: ts,
            });
          }
      }
      break;
    }

    case 'validation': {
      if (event.validationPassed === true) {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: event.validationLabel ?? 'All checks passed!',
          emoji: '🎉',
          milestone: 'cheer',
          timestamp: ts,
        });
      } else if (event.validationPassed === false) {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: event.validationLabel ?? 'Found issues...',
          emoji: '😤',
          milestone: 'neutral',
          timestamp: ts,
        });
      }
      break;
    }

    case 'extraction': {
      if (event.variableName === 'VERDICT') {
        const pass = event.variableValue?.toUpperCase() === 'PASS';
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: pass ? 'Approved!' : 'Needs more work',
          emoji: pass ? '👍' : '👎',
          milestone: pass ? 'cheer' : 'neutral',
          timestamp: ts,
        });
      }
      break;
    }

    case 'step_complete': {
      const agentId = event.agentId?.toUpperCase();
      if (agentId === '__SHELL__') {
        const stepId = event.stepId;
        const isBuilding = stepId === 'build-check';
        const isServer = stepId === 'server-check';
        const isTestVerify = stepId === 'test-verify';
        const isTestGateRed = stepId === 'test-gate-red';
        const isTamper = stepId === 'tamper-check';
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: isBuilding
            ? 'Build passed!'
            : isServer
              ? 'Server OK!'
              : isTestVerify
                ? 'Tests green!'
                : isTestGateRed
                  ? 'Red confirmed — tests fail as expected'
                  : isTamper
                    ? 'Tamper scan clean'
                    : 'Check passed!',
          emoji: '✅',
          milestone: 'cheer',
          timestamp: ts,
        });
      } else if (agentId === 'DEV') {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: 'Done coding!',
          emoji: '✅',
          milestone: 'cheer',
          timestamp: ts,
        });
      } else if (agentId === 'REVIEWER') {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: 'Review complete!',
          emoji: '📝',
          milestone: 'neutral',
          timestamp: ts,
        });
      } else if (agentId === 'TEST') {
        const stepId = event.stepId;
        const msg =
          stepId === 'test-author'
            ? 'Tests authored!'
            : stepId === 'test-verify'
              ? 'Tests pass!'
              : stepId === 'tamper-check'
                ? 'No tamper detected'
                : 'Tests done!';
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: msg,
          emoji: '🧪',
          milestone: 'cheer',
          timestamp: ts,
        });
      }
      break;
    }

    case 'step_error': {
      const errorAgentId = event.agentId?.toUpperCase();
      if (errorAgentId === '__SHELL__') {
        const stepId = event.stepId;
        const isBuilding = stepId === 'build-check';
        const isServer = stepId === 'server-check';
        const isTestVerify = stepId === 'test-verify';
        const isTamper = stepId === 'tamper-check';
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: isBuilding
            ? 'Build failed!'
            : isServer
              ? 'Server crashed!'
              : isTestVerify
                ? 'Tests failed!'
                : isTamper
                  ? 'Tamper detected — reverted'
                  : 'Check failed!',
          emoji: '❌',
          milestone: 'defeat',
          timestamp: ts,
        });
      } else if (errorAgentId === 'TEST') {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: 'Test step failed...',
          emoji: '🧪',
          milestone: 'defeat',
          timestamp: ts,
        });
      } else {
        actions.push({
          type: 'milestone',
          characterId: ctx.characterId,
          message: 'Something went wrong...',
          emoji: '⚠️',
          milestone: 'defeat',
          timestamp: ts,
        });
      }
      break;
    }

    default:
      break;
  }

  return actions;
}

/**
 * Periodic "Thinking..." bubble from accumulated text_delta events.
 * Scene code calls this every ~5s instead of per delta.
 */
export function createThinkingAction(characterId: CharacterId): OfficeAction {
  return {
    type: 'chat',
    characterId,
    message: 'Thinking...',
    emoji: '🤔',
    timestamp: Date.now(),
  };
}

// ── Orchestrator-wide events ──────────────────────────────────────────────

export const ORCHESTRATOR_EVENT_TYPES: ReadonlySet<string> = new Set([
  'epic_start',
  'epic_complete',
  'epic_failed',
  'wave_start',
  'wave_complete',
  'wave_split',
  'wave_collision',
  'touch_points_expanded',
  'subagent_dispatch',
  'subagent_return',
  'dev_blocker_reported',
  'story_blocked',
  'review_verdict',
  'remediation_start',
  'story_failed_terminally',
  'blocker_resolved',
]);

export function isOrchestratorEventType(eventType: string): boolean {
  return ORCHESTRATOR_EVENT_TYPES.has(eventType);
}

function str(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' ? v : undefined;
}

function num(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = payload?.[key];
  return typeof v === 'number' ? v : undefined;
}

function strArray(payload: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const v = payload?.[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/**
 * Translate a raw orchestrator event into a single typed animation intent.
 * Unknown event types log a warn and return a `noop` intent — never throws.
 */
export function translateOrchestratorIntent(event: OrchestratorEvent): OrchestratorAnimationIntent {
  const p = event.payload;
  const storyId = event.storyId ?? str(p, 'storyId');
  const subagentId = event.subagentId ?? str(p, 'subagentId');
  const attempt = event.attempt ?? num(p, 'attempt') ?? 1;

  switch (event.eventType) {
    case 'epic_start':
      return {
        type: 'supervisor_dispatch',
        status: 'dispatching',
        epicId: event.epicId ?? str(p, 'epicId') ?? '',
        maxParallel: num(p, 'maxParallel'),
        storyCount: num(p, 'storyCount'),
        totalWaves: num(p, 'totalWaves'),
      };

    case 'epic_complete':
      return {
        type: 'supervisor_complete',
        epicId: event.epicId ?? str(p, 'epicId') ?? '',
        summary: p?.storyResults,
      };

    case 'epic_failed':
      return {
        type: 'supervisor_fail',
        epicId: event.epicId ?? str(p, 'epicId') ?? '',
        reason: str(p, 'reason'),
      };

    case 'wave_start':
      return {
        type: 'wave_band_activate',
        waveNumber: num(p, 'waveNumber') ?? 0,
        storyIds: strArray(p, 'storyIds') ?? [],
      };

    case 'wave_complete':
      return {
        type: 'wave_band_deactivate',
        waveNumber: num(p, 'waveNumber') ?? 0,
        outcomes: (p?.outcomes as Record<string, string> | undefined) ?? undefined,
      };

    case 'wave_split': {
      const subWavesRaw = p?.subWaves;
      const subWaves: string[][] | undefined = Array.isArray(subWavesRaw)
        ? (subWavesRaw as string[][]).filter((sw) => Array.isArray(sw))
        : undefined;
      return {
        type: 'wave_collision_flash',
        waveNumber: num(p, 'waveNumber') ?? 0,
        subWaves,
      };
    }

    case 'wave_collision':
      return {
        type: 'wave_collision_flash',
        waveNumber: num(p, 'waveNumber') ?? 0,
        storyId,
        siblingStoryId: str(p, 'siblingStoryId'),
        offendingFiles: strArray(p, 'offendingFiles'),
      };

    case 'touch_points_expanded':
      return {
        type: 'touch_points_update',
        storyId: storyId ?? '',
        before: strArray(p, 'before'),
        after: strArray(p, 'after'),
        source: str(p, 'source'),
      };

    case 'subagent_dispatch': {
      const role = event.role ?? (str(p, 'role') as OrchestratorRole | undefined) ?? 'dev';
      if (role === 'reviewer') {
        return {
          type: 'reviewer_spawn',
          storyId: storyId ?? '',
          subagentId: subagentId ?? '',
          attempt,
        };
      }
      if (attempt > 1) {
        return {
          type: 'remediation_respawn',
          storyId: storyId ?? '',
          subagentId,
          attempt,
        };
      }
      return {
        type: 'dev_spawn',
        storyId: storyId ?? '',
        subagentId: subagentId ?? '',
        attempt,
      };
    }

    case 'subagent_return': {
      const role = event.role ?? (str(p, 'role') as OrchestratorRole | undefined) ?? 'dev';
      const durationMs = num(p, 'durationMs');
      if (role === 'reviewer') {
        return {
          type: 'reviewer_despawn',
          storyId: storyId ?? '',
          subagentId: subagentId ?? '',
          durationMs,
        };
      }
      return {
        type: 'dev_despawn',
        storyId: storyId ?? '',
        subagentId: subagentId ?? '',
        durationMs,
      };
    }

    case 'remediation_start':
      return {
        type: 'remediation_respawn',
        storyId: storyId ?? '',
        subagentId,
        attempt,
      };

    case 'review_verdict':
      return {
        type: 'review_verdict_pulse',
        storyId: storyId ?? '',
        verdict: str(p, 'verdict') ?? 'UNKNOWN',
        attempt,
        findings: Array.isArray(p?.findings) ? (p?.findings as unknown[]) : undefined,
      };

    case 'dev_blocker_reported':
      return {
        type: 'blocker_card_place',
        storyId: storyId ?? '',
        blockerCode: str(p, 'blockerCode') ?? str(p, 'code'),
        description: str(p, 'blockerDescription') ?? str(p, 'description'),
      };

    case 'story_blocked':
      return {
        type: 'story_desk_blocked_ring',
        storyId: storyId ?? '',
        blockerCode: str(p, 'blockerCode'),
        suggestedResolution: str(p, 'suggestedResolution'),
      };

    case 'blocker_resolved': {
      const action = str(p, 'action');
      return {
        type: 'blocker_card_remove',
        storyId: storyId ?? '',
        action: action === 'amend' || action === 'skip' || action === 'retry' ? action : undefined,
      };
    }

    case 'story_failed_terminally':
      return {
        type: 'story_desk_terminal_fail',
        storyId: storyId ?? '',
        reason: str(p, 'reason'),
      };

    default:
      console.warn(`[orchestrator-translator] unknown event type: ${event.eventType}`);
      return { type: 'noop', reason: `unknown event type: ${event.eventType}` };
  }
}
