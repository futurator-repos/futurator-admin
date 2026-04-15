import type { AgentEvent } from '@/types/agent-orchestrator';
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
