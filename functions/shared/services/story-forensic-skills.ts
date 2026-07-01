/**
 * story-forensic-skills — Pipeline-3 parity (G4).
 *
 * Pure aggregation that surfaces the skills a P3 run actually activated into the
 * forensic "Skills & Learnings" tab. In legacy the digest endpoint
 * (`GET /api/apps/:appId/skills/digest`) reads agent-events `skill_activated`
 * rows; P3's story-dev path records activations to `.context/loaded-skills.json`
 * (loaded-skills-tracker.mjs) and stamps them onto the per-story commit trailer
 * (`Skills-Used:`) and, via the persistence glue, onto the plan-spec-graph story
 * row / the story-dev job row. This function reads whatever skill provenance is
 * present on those rows and rolls it up — it is deliberately tolerant of shape so
 * it keeps working as the persisted surface grows.
 *
 * Input: the plan's story rows (plan-spec-graph) + the plan's story-dev jobs
 * (agent-jobs). Output: a plan-wide `activatedSkills` count + a `perJob`
 * breakdown for the tab's per-story drill-down.
 */

export interface SkillRef {
  skill: string;
  source: string;
}

export interface ActivatedSkill extends SkillRef {
  activationCount: number;
}

export interface JobSkills {
  jobId: string;
  skills: SkillRef[];
}

export interface ForensicSkills {
  activatedSkills: ActivatedSkill[];
  perJob: JobSkills[];
}

/** A plan-spec-graph story row, read for its (optional) skill provenance. */
interface StoryRowLike {
  storyId?: unknown;
  jobId?: unknown;
  loadedSkills?: unknown;
  skillsUsed?: unknown;
}

/** A story-dev agent-job row, read for its (optional) skill provenance. */
interface JobLike {
  jobId?: unknown;
  storyNodeRef?: { storyId?: unknown } | null;
  storyDevPayload?: { storyId?: unknown } | null;
  storyDevResult?: { loadedSkills?: unknown; skillsUsed?: unknown } | null;
  loadedSkills?: unknown;
  skillsUsed?: unknown;
}

/**
 * Normalize a raw skills field into `{skill, source}` refs. Accepts:
 *   - `[{ skill, source }]`     (loaded-skills-tracker shape)
 *   - `[{ name, source }]`      (catalog-ish shape)
 *   - `["<skill>@<source>"]`    (Skills-Used trailer token shape)
 *   - `["<skill>"]`             (bare name → source 'unknown')
 * Anything else is dropped.
 */
function normalizeSkillEntries(raw: unknown): SkillRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillRef[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const token = entry.trim();
      if (!token) continue;
      const at = token.lastIndexOf('@');
      if (at > 0) {
        out.push({ skill: token.slice(0, at), source: token.slice(at + 1) || 'unknown' });
      } else {
        out.push({ skill: token, source: 'unknown' });
      }
    } else if (entry && typeof entry === 'object') {
      const o = entry as { skill?: unknown; name?: unknown; source?: unknown };
      const skill =
        typeof o.skill === 'string' ? o.skill : typeof o.name === 'string' ? o.name : null;
      if (!skill) continue;
      const source = typeof o.source === 'string' && o.source.length > 0 ? o.source : 'unknown';
      out.push({ skill, source });
    }
  }
  return out;
}

function dedupeSkills(skills: SkillRef[]): SkillRef[] {
  const seen = new Set<string>();
  const out: SkillRef[] = [];
  for (const s of skills) {
    const key = `${s.skill}@${s.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Build the forensic skills rollup for a plan.
 *
 * @param planStoryRows plan-spec-graph rows for the plan (any array; tolerant).
 * @param jobs          the plan's story-dev agent-job rows (any array; tolerant).
 */
export function buildForensicSkills(
  planStoryRows: readonly StoryRowLike[] | null | undefined,
  jobs: readonly JobLike[] | null | undefined,
): ForensicSkills {
  const storyRows = Array.isArray(planStoryRows) ? planStoryRows : [];
  const jobRows = Array.isArray(jobs) ? jobs : [];

  // storyId → skills, from the persisted plan-spec-graph rows.
  const skillsByStory = new Map<string, SkillRef[]>();
  for (const row of storyRows) {
    if (!row || typeof row !== 'object') continue;
    const sid = asString(row.storyId);
    if (!sid) continue;
    const skills = dedupeSkills([
      ...normalizeSkillEntries(row.loadedSkills),
      ...normalizeSkillEntries(row.skillsUsed),
    ]);
    if (skills.length === 0) continue;
    skillsByStory.set(sid, dedupeSkills([...(skillsByStory.get(sid) ?? []), ...skills]));
  }

  const perJob: JobSkills[] = [];
  const counter = new Map<string, number>(); // "skill@source" → count

  for (const job of jobRows) {
    if (!job || typeof job !== 'object') continue;
    const jobId = asString(job.jobId);
    if (!jobId) continue;
    const storyId = asString(job.storyNodeRef?.storyId) ?? asString(job.storyDevPayload?.storyId);
    const skills = dedupeSkills([
      ...normalizeSkillEntries(job.loadedSkills),
      ...normalizeSkillEntries(job.skillsUsed),
      ...normalizeSkillEntries(job.storyDevResult?.loadedSkills),
      ...normalizeSkillEntries(job.storyDevResult?.skillsUsed),
      ...(storyId ? (skillsByStory.get(storyId) ?? []) : []),
    ]);
    perJob.push({ jobId, skills });
    for (const s of skills) {
      const key = `${s.skill}@${s.source}`;
      counter.set(key, (counter.get(key) ?? 0) + 1);
    }
  }

  const activatedSkills: ActivatedSkill[] = Array.from(counter.entries())
    .map(([key, activationCount]) => {
      const at = key.lastIndexOf('@');
      return { skill: key.slice(0, at), source: key.slice(at + 1), activationCount };
    })
    .sort((a, b) => b.activationCount - a.activationCount || a.skill.localeCompare(b.skill));

  return { activatedSkills, perJob };
}
