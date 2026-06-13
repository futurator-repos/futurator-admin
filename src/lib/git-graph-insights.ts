/**
 * git-graph-insights.ts — turn raw daemon commits into a human-readable,
 * groupable shape for the GitGraph "Story view" (dino1 UX pass, 2026-06-13).
 *
 * The daemon writes machine-precise commit subjects (raw story UUIDs, verbose
 * conflict lists, epic-ambiguous "wave 0"). Non-technical operators can't read
 * them. These pure helpers:
 *   - classify each commit into a kind + plain-language label + icon,
 *   - substitute story UUIDs with story titles (from the plan structure),
 *   - resolve each commit's epic + wave (from commit trailers, falling back to
 *     the story→epic map) so the view can group Epic → Wave → steps.
 *
 * All derivation is from data already present: the commit message (subject +
 * `Epic-Id:` / `Wave:` / `Story:` trailers the daemon emits via
 * commit-metadata.mjs) plus a storyId→epic map built from `plan.epics`.
 */

/** storyId → where it lives in the plan, for title + epic grouping. */
export interface StoryRef {
  title: string;
  epicId: string;
  epicTitle: string;
  epicOrder: number;
  storyOrder: number;
}
export type StoryMap = Record<string, StoryRef>;

export type CommitKind =
  | 'init'
  | 'scaffold'
  | 'skills'
  | 'plan'
  | 'story'
  | 'knowledge'
  | 'merge'
  | 'build-fix'
  | 'vqa'
  | 'vqa-fix'
  | 'regenerated'
  | 'other';

export interface CommitMeta {
  kind: CommitKind;
  icon: string;
  /** Plain-language, story-title-substituted summary for the row. */
  label: string;
  /**
   * Machine bookkeeping (compiler knowledge dumps, regenerated files) that
   * adds graph noise without telling the story → hidden unless the operator
   * opts into "Show machine commits".
   */
  isMachine: boolean;
  storyId?: string;
  epicId?: string;
  epicTitle?: string;
  epicOrder?: number;
  storyOrder?: number;
  wave?: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function trailer(fullMessage: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im');
  const m = fullMessage.match(re);
  return m ? m[1].trim() : undefined;
}

/** A short, friendly story handle: the title if we have it, else `#abcd1234`. */
function storyLabel(storyId: string | undefined, storyMap: StoryMap): string {
  if (!storyId) return '';
  return storyMap[storyId]?.title ?? `#${storyId.slice(0, 8)}`;
}

/**
 * Classify one commit and produce its plain-language label. `fullMessage` is
 * the complete commit message (subject + body + trailers); `storyMap` resolves
 * UUIDs to titles + epics.
 */
export function classifyCommit(fullMessage: string, storyMap: StoryMap = {}): CommitMeta {
  const subject = (fullMessage.split('\n')[0] || '').trim();

  // Trailers first — most reliable for epic/wave (daemon emits them).
  const epicIdTrailer = trailer(fullMessage, 'Epic-Id');
  const storyTrailer = trailer(fullMessage, 'Story');
  const waveTrailer = trailer(fullMessage, 'Wave');
  const waveNum =
    waveTrailer !== undefined && /^\d+$/.test(waveTrailer) ? Number(waveTrailer) : undefined;

  const resolveEpic = (storyId?: string, epicId?: string): Partial<CommitMeta> => {
    const ref = storyId ? storyMap[storyId] : undefined;
    if (ref) {
      return {
        epicId: ref.epicId,
        epicTitle: ref.epicTitle,
        epicOrder: ref.epicOrder,
        storyOrder: ref.storyOrder,
      };
    }
    return epicId ? { epicId } : {};
  };

  // ── story: <uuid> — <title> ──
  let m = subject.match(new RegExp(`^story:\\s*(${UUID})\\s*[—-]\\s*(.*)$`, 'i'));
  if (m) {
    const storyId = m[1];
    const title = storyMap[storyId]?.title ?? m[2].trim();
    return {
      kind: 'story',
      icon: '✍️',
      label: `Built — ${title}`,
      isMachine: false,
      storyId,
      wave: waveNum,
      ...resolveEpic(storyId, epicIdTrailer),
    };
  }

  // ── knowledge: story <uuid> compile artifacts (machine) ──
  m = subject.match(new RegExp(`knowledge:\\s*story\\s*(${UUID})`, 'i'));
  if (m) {
    const storyId = m[1];
    return {
      kind: 'knowledge',
      icon: '🧠',
      label: `Saved knowledge — ${storyLabel(storyId, storyMap)}`,
      isMachine: true,
      storyId,
      wave: waveNum,
      ...resolveEpic(storyId, epicIdTrailer),
    };
  }

  // ── merge story <uuid> into wave [conflict detail…] ──
  m = subject.match(new RegExp(`^merge story\\s*(${UUID})\\s*into wave`, 'i'));
  if (m) {
    const storyId = m[1];
    return {
      kind: 'merge',
      icon: '🔀',
      label: `Merged into wave — ${storyLabel(storyId, storyMap)}`,
      isMachine: false,
      storyId,
      wave: waveNum,
      ...resolveEpic(storyId, epicIdTrailer),
    };
  }

  // ── wave N: … (wave-level commits; epic comes from the trailer) ──
  const waveM = subject.match(/^wave\s+(\d+):\s*(.*)$/i);
  if (waveM) {
    const wave = Number(waveM[1]);
    const rest = waveM[2].toLowerCase();
    const epicBits = epicIdTrailer ? { epicId: epicIdTrailer } : {};
    if (rest.startsWith('agentic build-fix')) {
      return {
        kind: 'build-fix',
        icon: '🔧',
        label: 'Auto-fixed the build',
        isMachine: false,
        wave,
        ...epicBits,
      };
    }
    if (rest.startsWith('vqa-fix')) {
      return {
        kind: 'vqa-fix',
        icon: '🎨',
        label: 'Fixed visual issues',
        isMachine: false,
        wave,
        ...epicBits,
      };
    }
    if (rest.startsWith('vqa report')) {
      return {
        kind: 'vqa',
        icon: '👁️',
        label: 'Visual check',
        isMachine: false,
        wave,
        ...epicBits,
      };
    }
    if (rest.startsWith('regenerated files')) {
      return {
        kind: 'regenerated',
        icon: '♻️',
        label: 'Regenerated build files',
        isMachine: true,
        wave,
        ...epicBits,
      };
    }
    return { kind: 'other', icon: '•', label: subject, isMachine: false, wave, ...epicBits };
  }

  // ── setup / lifecycle commits ──
  if (/^initial commit/i.test(subject)) {
    return { kind: 'init', icon: '🌱', label: 'Project created', isMachine: false };
  }
  if (/post-create scaffold/i.test(subject)) {
    return { kind: 'scaffold', icon: '📦', label: 'Scaffolded the app', isMachine: false };
  }
  if (/^chore\(skills\)/i.test(subject)) {
    return { kind: 'skills', icon: '🧩', label: 'Confirmed skills', isMachine: false };
  }

  return {
    kind: 'other',
    icon: '•',
    label: subject,
    isMachine: false,
    storyId: storyTrailer,
    wave: waveNum,
    ...resolveEpic(storyTrailer, epicIdTrailer),
  };
}

/** Build the storyId→StoryRef map from the plan's epic/story structure. */
export function buildStoryMap(
  epics: ReadonlyArray<{
    epicId: string;
    title: string;
    order?: number;
    stories: ReadonlyArray<{ storyId: string; title: string; order?: number }>;
  }>,
): StoryMap {
  const map: StoryMap = {};
  epics.forEach((epic, ei) => {
    epic.stories.forEach((story, si) => {
      map[story.storyId] = {
        title: story.title,
        epicId: epic.epicId,
        epicTitle: epic.title,
        epicOrder: epic.order ?? ei,
        storyOrder: story.order ?? si,
      };
    });
  });
  return map;
}

export interface EpicGroup {
  epicId: string | null;
  epicTitle: string;
  epicOrder: number;
  waves: WaveGroup[];
  commitCount: number;
}
export interface WaveGroup {
  wave: number | null;
  indices: number[]; // indices into the (filtered) commit array, newest-first preserved
}

/**
 * Group already-classified commits into Epic → Wave for the Story view.
 * `metas[i]` corresponds to `commits[i]`; we only carry indices so the caller
 * keeps owning the commit objects. Commits with no resolvable epic land in a
 * single "Setup & lifecycle" group sorted to the top (epicOrder -1).
 */
export function groupByEpicWave(metas: CommitMeta[]): EpicGroup[] {
  const SETUP = '__setup__';
  const byEpic = new Map<string, EpicGroup>();

  metas.forEach((meta, i) => {
    const key = meta.epicId ?? SETUP;
    let g = byEpic.get(key);
    if (!g) {
      g =
        key === SETUP
          ? {
              epicId: null,
              epicTitle: 'Setup & lifecycle',
              epicOrder: -1,
              waves: [],
              commitCount: 0,
            }
          : {
              epicId: meta.epicId!,
              epicTitle: meta.epicTitle ?? meta.epicId!,
              epicOrder: meta.epicOrder ?? 999,
              waves: [],
              commitCount: 0,
            };
      byEpic.set(key, g);
    }
    // Keep the best title/order we've seen (story commits carry epicTitle +
    // epicOrder; wave commits may only carry epicId, so they seed the group
    // with the id and a later story commit upgrades the title/order).
    if (meta.epicTitle && g.epicTitle === g.epicId) g.epicTitle = meta.epicTitle;
    if (key !== SETUP && meta.epicOrder !== undefined && g.epicOrder === 999) {
      g.epicOrder = meta.epicOrder;
    }
    g.commitCount += 1;
    const waveKey = meta.wave ?? null;
    let w = g.waves.find((x) => x.wave === waveKey);
    if (!w) {
      w = { wave: waveKey, indices: [] };
      g.waves.push(w);
    }
    w.indices.push(i);
  });

  const groups = [...byEpic.values()];
  groups.sort((a, b) => a.epicOrder - b.epicOrder);
  for (const g of groups) {
    // Waves descending (newest wave first), nulls last.
    g.waves.sort((a, b) => (b.wave ?? -1) - (a.wave ?? -1));
  }
  return groups;
}
