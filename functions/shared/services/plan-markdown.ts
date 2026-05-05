import type { Plan } from '../types/plan';
import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';

/**
 * plan.md serializer — pure string in, string out. No I/O.
 *
 * Format mirrors what a human would naturally write, with YAML frontmatter
 * carrying the canonical IDs + status + createdAt for round-trip parsing.
 */

export function planToMarkdown(plan: Plan, epics: EpicWorkflow[]): string {
  const lines: string[] = [];

  // ── Frontmatter ──
  lines.push('---');
  lines.push(`planId: ${plan.planId}`);
  lines.push(`name: ${plan.name}`);
  lines.push(`status: ${plan.status}`);
  lines.push(`executionMode: ${plan.executionMode}`);
  lines.push(`createdAt: ${plan.createdAt}`);
  lines.push(`updatedAt: ${plan.updatedAt}`);
  lines.push('---');
  lines.push('');

  // ── Header ──
  lines.push(`# Plan: ${plan.name}`);
  lines.push('');

  // ── Intent ──
  lines.push('## Intent');
  lines.push('');
  lines.push(plan.intent);
  lines.push('');

  // ── Description ──
  if (plan.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(plan.description);
    lines.push('');
  }

  // ── Epics ──
  lines.push('## Epics');
  lines.push('');

  // Build a lookup from epicId → local label (E1, E2, ...) for rendering deps.
  const labelByEpicId = new Map<string, string>();
  epics.forEach((e, idx) => labelByEpicId.set(e.epicId, `E${idx + 1}`));

  epics.forEach((epic, idx) => {
    const label = `E${idx + 1}`;
    const deps = (epic.dependsOnEpics || [])
      .map((id) => labelByEpicId.get(id) || id)
      .join(', ');
    const depsLine = deps ? `  _(depends: ${deps})_` : '  _(no dependencies)_';
    lines.push(`### Epic ${label} — ${epic.title}`);
    lines.push('');
    lines.push(depsLine);
    lines.push('');
    lines.push(`**Goal:** ${epic.description || '_(not set)_'}`);
    lines.push('');
    if (epic.acceptanceCriteria) {
      lines.push('**Acceptance Criteria:**');
      lines.push('');
      // Each line of AC becomes a bullet.
      epic.acceptanceCriteria
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => lines.push(`- ${l.trim()}`));
      lines.push('');
    }

    if (epic.stories && epic.stories.length > 0) {
      lines.push('#### Stories');
      lines.push('');
      const storyLabelById = new Map<string, string>();
      epic.stories.forEach((s, sidx) => storyLabelById.set(s.storyId, `S${sidx + 1}`));
      epic.stories.forEach((story, sidx) => {
        const sLabel = `S${sidx + 1}`;
        const storyDeps = (story.dependsOn || [])
          .map((id) => storyLabelById.get(id) || id)
          .join(', ');
        const storyDepsLine = storyDeps ? `_(depends: ${storyDeps})_` : '_(no dependencies)_';
        lines.push(`- **${sLabel} — ${story.title}** ${storyDepsLine}`);
        if (story.description) {
          story.description
            .split('\n')
            .filter((l) => l.trim())
            .forEach((l) => lines.push(`  ${l}`));
        }
      });
      lines.push('');
    }
  });

  return lines.join('\n');
}

// ── Parser ────────────────────────────────────────────────────────────────

export interface ParsedPlanMarkdown {
  frontmatter: {
    planId?: string;
    name?: string;
    status?: string;
    executionMode?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  intent: string;
  description: string;
  epics: Array<{
    label: string;
    title: string;
    dependsOn: string[]; // local labels, e.g. ["E1"]
    goal: string;
    acceptanceCriteria: string;
    stories: Array<{
      label: string;
      title: string;
      dependsOn: string[];
      description: string;
    }>;
  }>;
}

/**
 * Parse a plan.md back into its structural parts.
 *
 * Lenient: handles minor formatting drift (extra blank lines, missing sections).
 * Strict about frontmatter shape (YAML-ish `key: value` lines between `---`
 * fences at the top).
 */
export function parsePlanMarkdown(text: string): ParsedPlanMarkdown {
  const result: ParsedPlanMarkdown = {
    frontmatter: {},
    intent: '',
    description: '',
    epics: [],
  };

  const lines = text.split('\n');
  let i = 0;

  // Frontmatter
  if (lines[i]?.trim() === '---') {
    i++;
    while (i < lines.length && lines[i].trim() !== '---') {
      const m = /^([a-zA-Z]+):\s*(.*)$/.exec(lines[i]);
      if (m) {
        const key = m[1] as keyof ParsedPlanMarkdown['frontmatter'];
        (result.frontmatter as Record<string, string>)[key] = m[2].trim();
      }
      i++;
    }
    if (lines[i]?.trim() === '---') i++;
  }

  // Walk sections
  let currentSection: 'intent' | 'description' | 'epics' | null = null;
  let currentEpic: ParsedPlanMarkdown['epics'][0] | null = null;
  const epicBuf: { goal: string[]; ac: string[] } = { goal: [], ac: [] };
  let readingAc = false;

  const flushEpic = () => {
    if (currentEpic) {
      currentEpic.goal = epicBuf.goal.join('\n').trim();
      currentEpic.acceptanceCriteria = epicBuf.ac.join('\n').trim();
      result.epics.push(currentEpic);
    }
    currentEpic = null;
    epicBuf.goal = [];
    epicBuf.ac = [];
    readingAc = false;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^#\s+Plan:\s*/.test(trimmed)) continue;

    if (/^##\s+Intent\s*$/.test(trimmed)) {
      currentSection = 'intent';
      continue;
    }
    if (/^##\s+Description\s*$/.test(trimmed)) {
      currentSection = 'description';
      continue;
    }
    if (/^##\s+Epics\s*$/.test(trimmed)) {
      currentSection = 'epics';
      continue;
    }

    if (currentSection === 'epics') {
      const epicM = /^###\s+Epic\s+(\S+)\s+—\s+(.+)$/.exec(trimmed);
      if (epicM) {
        flushEpic();
        currentEpic = {
          label: epicM[1],
          title: epicM[2].trim(),
          dependsOn: [],
          goal: '',
          acceptanceCriteria: '',
          stories: [],
        };
        readingAc = false;
        continue;
      }
      const depsM = /^_\(depends:\s*(.+?)\)_\s*$/.exec(trimmed);
      if (depsM && currentEpic) {
        currentEpic.dependsOn = depsM[1].split(',').map((s) => s.trim());
        continue;
      }
      const goalM = /^\*\*Goal:\*\*\s*(.+)$/.exec(trimmed);
      if (goalM && currentEpic) {
        epicBuf.goal.push(goalM[1]);
        continue;
      }
      if (/^\*\*Acceptance Criteria:\*\*/.test(trimmed)) {
        readingAc = true;
        continue;
      }
      if (readingAc && trimmed.startsWith('- ')) {
        epicBuf.ac.push(trimmed.slice(2));
        continue;
      }
      if (/^####\s+Stories\s*$/.test(trimmed)) {
        readingAc = false;
        continue;
      }
      const storyM = /^-\s+\*\*(\S+)\s+—\s+(.+?)\*\*\s*(?:_\(depends:\s*(.+?)\)_)?/.exec(trimmed);
      if (storyM && currentEpic) {
        currentEpic.stories.push({
          label: storyM[1],
          title: storyM[2].trim(),
          dependsOn: storyM[3] ? storyM[3].split(',').map((s) => s.trim()) : [],
          description: '',
        });
        continue;
      }
      // Indented continuation → story description
      if (currentEpic && currentEpic.stories.length > 0 && /^  \S/.test(line)) {
        const last = currentEpic.stories[currentEpic.stories.length - 1];
        last.description = (last.description + '\n' + line.trim()).trim();
      }
      continue;
    }

    if (currentSection === 'intent') {
      if (trimmed) result.intent = (result.intent + '\n' + line).trim();
    }
    if (currentSection === 'description') {
      if (trimmed) result.description = (result.description + '\n' + line).trim();
    }
  }
  flushEpic();

  return result;
}

// ── Local-label → EpicStory helpers ───────────────────────────────────────

/**
 * Resolve "E1", "E2" local labels to real epicIds using an ordered list.
 *
 * Used when converting parsed plan.md back into structured Plan data: the
 * labels are relative to the epic's position in the document.
 */
export function resolveEpicLabels(labels: string[], orderedEpicIds: string[]): string[] {
  return labels
    .map((label) => {
      const m = /^E(\d+)$/.exec(label);
      if (!m) return null;
      const idx = parseInt(m[1], 10) - 1;
      return orderedEpicIds[idx] ?? null;
    })
    .filter((id): id is string => id !== null);
}

export function resolveStoryLabels(
  labels: string[],
  orderedStories: Pick<EpicStory, 'storyId'>[],
): string[] {
  return labels
    .map((label) => {
      const m = /^S(\d+)$/.exec(label);
      if (!m) return null;
      const idx = parseInt(m[1], 10) - 1;
      return orderedStories[idx]?.storyId ?? null;
    })
    .filter((id): id is string => id !== null);
}
