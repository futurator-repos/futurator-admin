/**
 * Static lookup tables used across dashboard views. Ported from the prototype
 * `helpers.jsx` but typed and kept separate from the adapter so views can
 * import the constants without pulling the whole adapter module.
 */

import type { PlanStatus } from '@/types/plan';
import type { StoryStatus, EpicStatus } from '@/types/epic-workflow';

export interface StatusMeta {
  label: string;
  /** Semantic CSS variable or direct hex for dots/borders/backgrounds. */
  color: string;
}

/** Plan-level status pill meta. */
export const PLAN_STATUS_META: Record<PlanStatus, StatusMeta> = {
  concept: { label: 'Concept', color: 'var(--text-mute)' },
  developing: { label: 'Developing', color: 'var(--accent-purple)' },
  fixing: { label: 'Fixing', color: 'var(--destructive)' },
  review: { label: 'Review', color: 'var(--warning)' },
  delivered: { label: 'Delivered', color: 'var(--success)' },
  abandoned: { label: 'Abandoned', color: 'var(--text-faint)' },
  archived: { label: 'Archived', color: 'var(--text-faint)' },
};

/** Story-level status pill meta. */
export const STORY_STATUS_META: Record<StoryStatus, StatusMeta> = {
  pending: { label: 'Backlog', color: 'var(--text-mute)' },
  queued: { label: 'Queued', color: 'var(--text-dim)' },
  running: { label: 'Developing', color: 'var(--accent-purple)' },
  in_review: { label: 'In review', color: 'var(--warning)' },
  fixing: { label: 'Fixing', color: 'var(--destructive)' },
  done: { label: 'Done', color: 'var(--success)' },
  failed: { label: 'Failed', color: 'var(--destructive)' },
  blocked: { label: 'Blocked', color: 'var(--destructive)' },
  skipped: { label: 'Skipped', color: 'var(--text-faint)' },
};

/** Epic-level status → display color. */
export function epicStatusColor(status: EpicStatus): string {
  switch (status) {
    case 'completed':
    case 'deployed':
      return 'var(--success)';
    case 'in_progress':
      return 'var(--accent-purple)';
    case 'in_review':
      return 'var(--warning)';
    case 'fixing':
    case 'failed':
      return 'var(--destructive)';
    case 'ready':
    case 'draft':
    default:
      return 'var(--text-mute)';
  }
}

/** Kanban collapses the 9 story statuses into 5 user-facing columns. */
export interface KanbanColumn {
  id: 'pending' | 'queued' | 'running' | 'in_review' | 'done';
  label: string;
  matches: StoryStatus[];
}

export const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'pending', label: 'Backlog', matches: ['pending', 'skipped'] },
  { id: 'queued', label: 'Queued', matches: ['queued'] },
  { id: 'running', label: 'Developing', matches: ['running', 'fixing', 'blocked'] },
  { id: 'in_review', label: 'In review', matches: ['in_review'] },
  { id: 'done', label: 'Done', matches: ['done', 'failed'] },
];

/** Stories that should animate (pulse + shimmer) in the UI. */
export const ACTIVE_STORY_STATUSES: StoryStatus[] = ['running', 'in_review', 'fixing'];

/** Pipeline stages shown between Hero and Tabs. */
export interface PipelineStage {
  id: 'concept' | 'developing' | 'qa' | 'deploy' | 'published';
  label: string;
  sub: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { id: 'concept', label: 'Concept', sub: 'intent drafted' },
  { id: 'developing', label: 'Developing', sub: 'agents running' },
  { id: 'qa', label: 'QA Review', sub: 'visual + PO audit' },
  { id: 'deploy', label: 'Deploy', sub: 'push to S3' },
  { id: 'published', label: 'Published', sub: 'live on futurator.ai' },
];

export function pipelineStageIndexFor(status: PlanStatus): number {
  switch (status) {
    case 'concept':
      return 0;
    case 'developing':
    case 'fixing':
      return 1;
    case 'review':
      return 2;
    case 'delivered':
      return 4;
    case 'abandoned':
    case 'archived':
    default:
      return 0;
  }
}
