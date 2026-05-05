import type { EpicWorkflow } from '../types/epic-workflow';

/**
 * Topologically sort epics by their `dependsOnEpics` graph and return a
 * map of `epicId → planWave` number.
 *
 * Plan-wave 0 = epics with no dependencies.
 * Plan-wave N = epics whose deepest dependency is at plan-wave N-1.
 *
 * Mirrors the existing story-wave algorithm one level up. Throws on cycles.
 */
export function computePlanWaves(epics: EpicWorkflow[]): Record<string, number> {
  const waveByEpicId: Record<string, number> = {};
  const remaining = new Set(epics.map((e) => e.epicId));
  const epicsById = new Map(epics.map((e) => [e.epicId, e] as const));

  // Filter out dep IDs that reference epics NOT in this set (legacy rows or
  // epics from other plans that somehow leaked in). Never let a stale dep
  // block the whole plan.
  const validDeps = (epic: EpicWorkflow): string[] =>
    (epic.dependsOnEpics || []).filter((id) => epicsById.has(id));

  let currentWave = 0;
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const epicId of remaining) {
      const epic = epicsById.get(epicId)!;
      const allDepsResolved = validDeps(epic).every((depId) => depId in waveByEpicId);
      if (allDepsResolved) ready.push(epicId);
    }
    if (ready.length === 0) {
      // Cycle or unresolvable deps.
      throw new Error(
        `computePlanWaves: cycle or unresolvable dependency detected among ${[...remaining].join(', ')}`,
      );
    }
    for (const epicId of ready) {
      waveByEpicId[epicId] = currentWave;
      remaining.delete(epicId);
    }
    currentWave++;
  }

  return waveByEpicId;
}

/**
 * Get all epics in a specific plan-wave.
 */
export function epicsInPlanWave(
  epics: EpicWorkflow[],
  planWaves: Record<string, number>,
  waveNumber: number,
): EpicWorkflow[] {
  return epics.filter((e) => planWaves[e.epicId] === waveNumber);
}

/**
 * Find the first plan-wave (min wave number) that contains any epic. Used by
 * the plan-start endpoint to know which epics to launch initially.
 */
export function findFirstPlanWave(planWaves: Record<string, number>): number {
  const waves = Object.values(planWaves);
  if (waves.length === 0) return 0;
  return Math.min(...waves);
}

/**
 * Compute the highest plan-wave number — useful for deciding if we've run
 * the final plan-build-check.
 */
export function maxPlanWave(planWaves: Record<string, number>): number {
  const waves = Object.values(planWaves);
  if (waves.length === 0) return -1;
  return Math.max(...waves);
}
