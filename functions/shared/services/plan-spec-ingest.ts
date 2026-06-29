/**
 * plan-spec-ingest — land a converged plan_spec as StoryNode rows (development-plan §5.1).
 *
 * The contract is asserted here, atomically: the WHOLE spec is rejected on any
 * error (never half-ingested). Guarantees:
 *   1. shape parses (Zod `.safeParse`);
 *   2. `depends_on` resolves within the spec AND forms a DAG (cycle/dangling ⇒ reject);
 *   3. every story has ≥1 `touches` (schema) — EPIC_WIDE sentinel allowed;
 *   4. every AC carries a `testBinding` (schema default `unbound`);
 *   5. `specShardRef.contentHash` present when a shard is referenced (schema).
 *
 * Seeds the event-driven Kahn columns (no full-graph scan later):
 *   `unblockedDepsCount = depends_on.length`, `state = ready` if 0 else `blocked`,
 *   `cohortBatch = topological level`.
 *
 * Idempotent: batch-put keyed by `storyId`, version bumped. Does NOT enqueue jobs
 * — the dispatcher (ready-frontier) owns minting. Stamps the Plan row
 * concept→developing via the injected planRepo (best-effort).
 */

import {
  planSpecSchema,
  type ParsedPlanSpec,
  type ParsedStoryNode,
} from '../schemas/plan-spec-schema';
import type { StoryNodeRow, StoryNodeState } from '../types/plan-spec';

export interface StoryNodeRepository {
  batchPutStoryNodes(rows: StoryNodeRow[]): Promise<void>;
}
export interface PlanStageRepository {
  markDeveloping?(planId: string): Promise<void>;
}

export interface IngestResult {
  ok: boolean;
  rows?: StoryNodeRow[];
  summary?: { stories: number; ready: number; blocked: number; maxBatch: number };
  errors?: string[];
}

/** Detect cycles + dangling deps over the spec's story set. Pure. */
function checkDag(stories: ParsedStoryNode[]): {
  cycles: string[][];
  dangling: Array<{ storyId: string; missing: string }>;
} {
  const ids = new Set(stories.map((s) => s.storyId));
  const map = new Map(stories.map((s) => [s.storyId, s]));
  const dangling: Array<{ storyId: string; missing: string }> = [];
  for (const s of stories)
    for (const d of s.depends_on)
      if (!ids.has(d)) dangling.push({ storyId: s.storyId, missing: d });

  const cycles: string[][] = [];
  const color = new Map<string, number>(stories.map((s) => [s.storyId, 0])); // 0 white 1 gray 2 black
  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of map.get(id)?.depends_on ?? []) {
      if (!ids.has(dep)) continue;
      const c = color.get(dep);
      if (c === 1) cycles.push(stack.slice(stack.indexOf(dep)).concat(dep));
      else if (c === 0) visit(dep);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const s of stories) if (color.get(s.storyId) === 0) visit(s.storyId);
  return { cycles, dangling };
}

/** Topological level per story (cohortBatch). Assumes a valid DAG. Pure. */
function topoLevels(stories: ParsedStoryNode[]): Map<string, number> {
  const ids = new Set(stories.map((s) => s.storyId));
  const map = new Map(stories.map((s) => [s.storyId, s]));
  const level = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (level.has(id)) return level.get(id)!;
    if (seen.has(id)) return 0; // guarded by checkDag; defensive
    seen.add(id);
    const deps = (map.get(id)?.depends_on ?? []).filter((d) => ids.has(d));
    const lv = deps.length ? Math.max(...deps.map((d) => resolve(d, seen))) + 1 : 0;
    level.set(id, lv);
    return lv;
  };
  for (const s of stories) resolve(s.storyId, new Set());
  return level;
}

export async function ingestPlanSpec(
  raw: unknown,
  deps: { repo: StoryNodeRepository; planRepo?: PlanStageRepository; now?: () => string },
): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date().toISOString());

  const parsed = planSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const spec: ParsedPlanSpec = parsed.data;

  // contract guarantee 2 — DAG.
  const { cycles, dangling } = checkDag(spec.stories);
  const errors: string[] = [];
  if (cycles.length)
    errors.push(`depends_on has cycle(s): ${cycles.map((c) => c.join('→')).join(' ; ')}`);
  if (dangling.length)
    errors.push(
      `dangling depends_on: ${dangling.map((d) => `${d.storyId}→${d.missing}`).join(', ')}`,
    );
  // global story-id uniqueness.
  const seen = new Set<string>();
  for (const s of spec.stories) {
    if (seen.has(s.storyId)) errors.push(`duplicate storyId: ${s.storyId}`);
    seen.add(s.storyId);
  }
  if (errors.length) return { ok: false, errors };

  const levels = topoLevels(spec.stories);
  const ts = now();
  let ready = 0;
  let blocked = 0;
  let maxBatch = 0;

  const rows: StoryNodeRow[] = spec.stories.map((s) => {
    const unblockedDepsCount = s.depends_on.length;
    const state: StoryNodeState = unblockedDepsCount === 0 ? 'ready' : 'blocked';
    if (state === 'ready') ready += 1;
    else blocked += 1;
    const cohortBatch = levels.get(s.storyId) ?? 0;
    maxBatch = Math.max(maxBatch, cohortBatch);
    return {
      ...(s as ParsedStoryNode),
      planId: spec.planId,
      appId: spec.appId,
      state,
      unblockedDepsCount,
      cohortBatch,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    } as StoryNodeRow;
  });

  await deps.repo.batchPutStoryNodes(rows);
  if (deps.planRepo?.markDeveloping) {
    try {
      await deps.planRepo.markDeveloping(spec.planId);
    } catch {
      /* best-effort */
    }
  }

  return { ok: true, rows, summary: { stories: rows.length, ready, blocked, maxBatch } };
}
