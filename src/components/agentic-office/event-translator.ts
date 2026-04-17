import type { AgentEvent, OrchestratorEvent, OrchestratorRole } from '@/types/agent-orchestrator';
import type { OfficeAction, WorkerRole, LocationKey } from '@/types/agentic-office';

// ── Parse tool input to extract the most human-readable part ──

function parseToolInput(input?: string): string {
  if (!input) return '';
  try {
    const parsed = JSON.parse(input);
    return parsed.file_path || parsed.command || parsed.pattern || parsed.path || '';
  } catch {
    return input.slice(0, 80);
  }
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function truncateCommand(cmd: string): string {
  if (cmd.length > 40) return cmd.slice(0, 37) + '...';
  return cmd;
}

// ── Classify bash commands ──

function classifyBashCommand(cmd: string): { emoji: string; message: string } {
  const lower = cmd.toLowerCase();
  if (lower.includes('npm test') || lower.includes('vitest') || lower.includes('jest')) {
    return { emoji: '🧪', message: 'Running tests...' };
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
  if (lower.includes('git ')) {
    return { emoji: '📋', message: 'Running git command...' };
  }
  if (lower.includes('aws ') || lower.includes('s3 ')) {
    return { emoji: '☁️', message: 'Running cloud command...' };
  }
  return { emoji: '⚡', message: `Running: ${truncateCommand(cmd)}` };
}

// ── Main translator ──

export interface TranslationContext {
  workerId: string;
  role: WorkerRole;
  epicId: string;
  storyId: string;
  storyTitle: string;
  deskLocation: LocationKey | null;
}

/**
 * Translates a raw AgentEvent into zero or more OfficeActions.
 * Returns an empty array if the event should be ignored.
 */
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
        actions.push({
          type: 'chat',
          workerId: ctx.workerId,
          message: isBuilding
            ? 'Running build...'
            : isServer
              ? 'Checking server...'
              : 'Running check...',
          emoji: isBuilding ? '🔨' : isServer ? '🌐' : '⚡',
          timestamp: ts,
        });
      } else if (agentId === 'DEV') {
        actions.push({
          type: 'chat',
          workerId: ctx.workerId,
          message: `Starting on ${ctx.storyTitle}`,
          emoji: '💪',
          timestamp: ts,
        });
      } else if (agentId === 'REVIEWER') {
        actions.push({
          type: 'chat',
          workerId: ctx.workerId,
          message: 'Reviewing the code...',
          emoji: '👀',
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
            workerId: ctx.workerId,
            message: input ? `Looking at ${basename(input)}` : 'Reading files...',
            emoji: '🔍',
            timestamp: ts,
          });
          break;
        case 'Edit':
          actions.push({
            type: 'chat',
            workerId: ctx.workerId,
            message: input ? `Editing ${basename(input)}` : 'Editing code...',
            emoji: '✏️',
            timestamp: ts,
          });
          break;
        case 'Write':
          actions.push({
            type: 'chat',
            workerId: ctx.workerId,
            message: input ? `Creating ${basename(input)}` : 'Writing new file...',
            emoji: '📝',
            timestamp: ts,
          });
          break;
        case 'Bash': {
          const { emoji, message } = classifyBashCommand(input);
          actions.push({
            type: 'chat',
            workerId: ctx.workerId,
            message,
            emoji,
            timestamp: ts,
          });
          break;
        }
        default:
          if (toolName) {
            actions.push({
              type: 'chat',
              workerId: ctx.workerId,
              message: `Using ${toolName}...`,
              emoji: '🔧',
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
          workerId: ctx.workerId,
          message: event.validationLabel ?? 'All checks passed!',
          emoji: '🎉',
          timestamp: ts,
        });
      } else if (event.validationPassed === false) {
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: event.validationLabel ?? 'Found issues...',
          emoji: '😤',
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
          workerId: ctx.workerId,
          message: pass ? 'Approved!' : 'Needs more work',
          emoji: pass ? '👍' : '👎',
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
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: isBuilding ? 'Build passed!' : isServer ? 'Server OK!' : 'Check passed!',
          emoji: '✅',
          timestamp: ts,
        });
      } else if (agentId === 'DEV') {
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: 'Done coding!',
          emoji: '✅',
          timestamp: ts,
        });
      } else if (agentId === 'REVIEWER') {
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: 'Review complete!',
          emoji: '📝',
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
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: isBuilding ? 'Build failed!' : isServer ? 'Server crashed!' : 'Check failed!',
          emoji: '❌',
          timestamp: ts,
        });
      } else {
        actions.push({
          type: 'milestone',
          workerId: ctx.workerId,
          message: 'Something went wrong...',
          emoji: '⚠️',
          timestamp: ts,
        });
      }
      break;
    }

    // text_delta, tool_result, result, status — ignored for chat bubbles
    // (text_delta is handled via periodic sampling in StoryTracker)
    default:
      break;
  }

  return actions;
}

/**
 * Create a "thinking" chat action from accumulated text deltas.
 * Called periodically (every ~5s) rather than on every text_delta event.
 */
export function createThinkingAction(workerId: string): OfficeAction {
  return {
    type: 'chat',
    workerId,
    message: 'Thinking...',
    emoji: '🤔',
    timestamp: Date.now(),
  };
}

// ── Orchestrator animation intents (Epic 6) ─────────────────────────────────

/**
 * Event types emitted by the epic orchestrator. A single shared event stream
 * carries both the legacy per-step events (tool_use, step_*, text_delta) and
 * these orchestrator-wide events — consumers gate on this set before routing
 * an event through `translateOrchestratorIntent`.
 */
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

//
// Each orchestrator event is translated into a single typed animation intent
// that the Three.js scene consumes to drive discrete visual changes (spawn,
// despawn, place card, flash band, etc.). Unknown events return a `noop`
// intent rather than throwing so stray/future events never break the scene.

export type SupervisorStatus = 'dispatching' | 'waiting' | 'conflict' | 'failed';

export type OrchestratorAnimationIntent =
  | {
      type: 'supervisor_dispatch';
      status: SupervisorStatus;
      epicId: string;
      maxParallel?: number;
      storyCount?: number;
      totalWaves?: number;
    }
  | { type: 'supervisor_complete'; epicId: string; summary?: unknown }
  | { type: 'supervisor_fail'; epicId: string; reason?: string }
  | {
      type: 'wave_band_activate';
      waveNumber: number;
      storyIds: string[];
    }
  | {
      type: 'wave_band_deactivate';
      waveNumber: number;
      outcomes?: Record<string, string>;
    }
  | {
      type: 'wave_collision_flash';
      waveNumber: number;
      storyId?: string;
      siblingStoryId?: string;
      offendingFiles?: string[];
      subWaves?: string[][];
    }
  | {
      type: 'touch_points_update';
      storyId: string;
      before?: string[];
      after?: string[];
      source?: string;
    }
  | {
      type: 'dev_spawn';
      storyId: string;
      subagentId: string;
      attempt: number;
    }
  | {
      type: 'reviewer_spawn';
      storyId: string;
      subagentId: string;
      attempt: number;
    }
  | {
      type: 'dev_despawn';
      storyId: string;
      subagentId: string;
      durationMs?: number;
    }
  | {
      type: 'reviewer_despawn';
      storyId: string;
      subagentId: string;
      durationMs?: number;
    }
  | {
      type: 'remediation_respawn';
      storyId: string;
      subagentId?: string;
      attempt: number;
    }
  | {
      type: 'review_verdict_pulse';
      storyId: string;
      verdict: string;
      attempt: number;
      findings?: unknown[];
    }
  | {
      type: 'blocker_card_place';
      storyId: string;
      blockerCode?: string;
      description?: string;
    }
  | {
      type: 'blocker_card_remove';
      storyId: string;
      action?: 'amend' | 'skip' | 'retry';
    }
  | {
      type: 'story_desk_blocked_ring';
      storyId: string;
      blockerCode?: string;
      suggestedResolution?: string;
    }
  | {
      type: 'story_desk_terminal_fail';
      storyId: string;
      reason?: string;
    }
  | { type: 'noop'; reason: string };

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
 *
 * See arch doc §9.2 for the event vocabulary and §10.3 for the visual
 * treatment each intent drives.
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
      // Never throw on unknown events — log and return a noop so the scene
      // keeps rendering whatever it already has.
      console.warn(`[orchestrator-translator] unknown event type: ${event.eventType}`);
      return { type: 'noop', reason: `unknown event type: ${event.eventType}` };
  }
}
