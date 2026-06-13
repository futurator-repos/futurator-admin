'use client';

/**
 * Git graph view for the Developing stage.
 *
 * Renders a SourceTree-style commit graph for the plan's GitHub repo
 * (futurator-repos/<appId>). Lane assignment is intentionally simple:
 *
 *   1. List branches; default branch always lands on lane 0.
 *   2. Walk each branch's first-parent chain. The first time we see a
 *      commit, it inherits that branch's lane. Subsequent branches that
 *      reach the same commit do NOT relabel it — so a feature branch that
 *      was merged into main is drawn on its own lane only for commits
 *      that haven't been swallowed into main's first-parent history.
 *
 * Every commit also remembers its parent SHAs so we can draw lines /
 * curves between rows when the parent's lane differs. The right column
 * lists commit metadata (subject, author, refs, hash, age); clicking a
 * row pops the detail panel below.
 */

import { useMemo, useState } from 'react';
import { Loader2, GitBranch, ChevronRight, ChevronDown } from 'lucide-react';
import { useGitGraph, type GitGraphResponse } from '@/hooks/use-git-graph';
import {
  classifyCommit,
  groupByEpicWave,
  type CommitMeta,
  type EpicGroup,
  type StoryMap,
} from '@/lib/git-graph-insights';
import type { GitHubCommit, GitHubPullRequest } from '../../../../../functions/shared/github/types';

const LANE_W = 22;
const ROW_H = 46;
const LANE_PAD = 18;
const GRAPH_W = 132;

const LANE_PALETTE: { color: string; tint: string }[] = [
  { color: '#7893b8', tint: 'rgba(120,147,184,0.14)' },
  { color: '#22c55e', tint: 'rgba(34,197,94,0.14)' },
  { color: '#a78bfa', tint: 'rgba(167,139,250,0.14)' },
  { color: '#d1a54f', tint: 'rgba(209,165,79,0.14)' },
  { color: '#ef4444', tint: 'rgba(239,68,68,0.14)' },
  { color: '#06b6d4', tint: 'rgba(6,182,212,0.14)' },
  { color: '#f97316', tint: 'rgba(249,115,22,0.14)' },
  { color: '#ec4899', tint: 'rgba(236,72,153,0.14)' },
];

interface BranchInfo {
  name: string;
  lane: number;
  color: string;
  tint: string;
  count: number;
  isDefault: boolean;
}

interface GraphCommit {
  sha: string;
  shortSha: string;
  message: string;
  /**
   * 2026-05-19 — full commit message body retained so the UI can grep
   * for v2.5 §23 trailers (`Plan-Id:`, `Story:`, `Wave:`) when scoping
   * the view to a specific plan. The `message` field stays as the
   * subject-only summary for row display.
   */
  fullMessage: string;
  authorName: string;
  authorLogin: string | null;
  authorAvatar: string | null;
  date: string;
  whenLabel: string;
  parents: string[];
  lane: number;
  branchHead: string | null;
  pr: GitHubPullRequest | null;
  htmlUrl: string;
}

interface GraphData {
  commits: GraphCommit[];
  branches: BranchInfo[];
  prCount: number;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min${m > 1 ? 's' : ''} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo > 1 ? 's' : ''} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

function buildGraph(data: GitGraphResponse): GraphData {
  const { commits, branches, pullRequests, repo } = data;

  const commitMap = new Map<string, GitHubCommit>();
  for (const c of commits) commitMap.set(c.sha, c);

  // Sort branches: default first, then by tip-commit recency (newest first).
  const sortedBranches = [...branches].sort((a, b) => {
    if (a.name === repo.default_branch) return -1;
    if (b.name === repo.default_branch) return 1;
    const ad = commitMap.get(a.commit.sha)?.commit.author.date ?? '0';
    const bd = commitMap.get(b.commit.sha)?.commit.author.date ?? '0';
    return bd.localeCompare(ad);
  });

  const laneByCommit = new Map<string, number>();
  const branchInfos: BranchInfo[] = [];

  sortedBranches.forEach((branch, idx) => {
    const palette = LANE_PALETTE[idx % LANE_PALETTE.length];
    let count = 0;
    let cur: string | undefined = branch.commit.sha;
    while (cur && commitMap.has(cur) && !laneByCommit.has(cur)) {
      laneByCommit.set(cur, idx);
      count++;
      const c = commitMap.get(cur);
      // Follow first-parent only — that's the chain the branch "claims".
      cur = c?.parents[0]?.sha;
    }
    branchInfos.push({
      name: branch.name,
      lane: idx,
      color: palette.color,
      tint: palette.tint,
      count,
      isDefault: branch.name === repo.default_branch,
    });
  });

  const branchHeadByCommit = new Map<string, string>();
  for (const b of sortedBranches) {
    if (commitMap.has(b.commit.sha)) {
      branchHeadByCommit.set(b.commit.sha, b.name);
    }
  }

  const prByMergeSha = new Map<string, GitHubPullRequest>();
  // Open PRs land on their head commit since they have no merge commit yet.
  const prByHeadSha = new Map<string, GitHubPullRequest>();
  for (const pr of pullRequests) {
    if (pr.merge_commit_sha) prByMergeSha.set(pr.merge_commit_sha, pr);
    if (pr.state === 'open') prByHeadSha.set(pr.head.sha, pr);
  }

  const graphCommits: GraphCommit[] = commits.map((c) => {
    const subject = c.commit.message.split('\n')[0];
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: subject,
      fullMessage: c.commit.message,
      authorName: c.author?.login || c.commit.author.name,
      authorLogin: c.author?.login ?? null,
      authorAvatar: c.author?.avatar_url ?? null,
      date: c.commit.author.date,
      whenLabel: timeAgo(c.commit.author.date),
      parents: c.parents.map((p) => p.sha),
      lane: laneByCommit.get(c.sha) ?? 0,
      branchHead: branchHeadByCommit.get(c.sha) ?? null,
      pr: prByMergeSha.get(c.sha) ?? prByHeadSha.get(c.sha) ?? null,
      htmlUrl: c.html_url,
    };
  });

  return { commits: graphCommits, branches: branchInfos, prCount: pullRequests.length };
}

function laneX(l: number): number {
  return LANE_PAD + l * LANE_W;
}
function rowY(i: number): number {
  return i * ROW_H + ROW_H / 2;
}

interface GraphPaths {
  paths: string[];
  dots: string[];
}

function buildPaths(commits: GraphCommit[], branches: BranchInfo[]): GraphPaths {
  const idxBySha = new Map<string, number>();
  commits.forEach((c, i) => idxBySha.set(c.sha, i));
  const laneOf = (lane: number) => branches[lane] ?? branches[0];

  const paths: string[] = [];
  const dots: string[] = [];

  commits.forEach((c, i) => {
    const cx = laneX(c.lane);
    const cy = rowY(i);

    c.parents.forEach((pid, pIdx) => {
      const pi = idxBySha.get(pid);
      if (pi === undefined) return;
      const p = commits[pi];
      const px = laneX(p.lane);
      const py = rowY(pi);
      const isMerge = pIdx > 0;
      const color =
        cx === px ? laneOf(c.lane).color : isMerge ? laneOf(p.lane).color : laneOf(c.lane).color;

      let d: string;
      if (cx === px) {
        d = `M${cx} ${cy} L${px} ${py}`;
      } else if (isMerge) {
        const midY = cy + ROW_H * 0.5;
        d = `M${px} ${py} L${px} ${midY} Q${px} ${cy} ${cx} ${cy}`;
      } else {
        const midY = py - ROW_H * 0.5;
        d = `M${px} ${py} Q${px} ${midY} ${cx} ${midY} L${cx} ${cy}`;
      }
      paths.push(
        `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    });

    const col = laneOf(c.lane).color;
    if (c.parents.length > 1) {
      dots.push(
        `<circle cx="${cx}" cy="${cy}" r="6.5" fill="var(--bg-elev)" stroke="${col}" stroke-width="2"/>`,
      );
      dots.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${col}"/>`);
    } else {
      dots.push(
        `<circle cx="${cx}" cy="${cy}" r="5" fill="${col}" stroke="var(--bg-elev)" stroke-width="1.5"/>`,
      );
    }
  });

  return { paths, dots };
}

// ── Top-level view ──────────────────────────────────────────────────

export function GitGraphView({
  appId,
  githubRepoUrl,
  planName,
  planSlug,
  planId,
  storyMap = {},
}: {
  appId: string | null | undefined;
  /** 2026-05-30 — the App's real repo (any org). Resolves owner/repo so the
   * graph queries the correct GitHub repo (brownfield) instead of assuming
   * futurator-repos. Absent → greenfield futurator-repos/<appId>. */
  githubRepoUrl?: string | null;
  planName: string;
  /**
   * 2026-05-19 — kebab-case plan slug. The view computes `plan/<slug>` and
   * defaults the lane filter to that branch when it exists in the repo's
   * branch list. Operator can flip to "show all" via the toggle in the
   * header. Absent → legacy plan (no per-plan branch); show all.
   */
  planSlug?: string;
  /**
   * 2026-05-19 — Plan DDB id. Used to highlight commits whose
   * `Plan-Id: <id>` trailer matches the current plan. Highlights are
   * additive — they appear regardless of which branch filter is active.
   */
  planId?: string;
  /**
   * 2026-06-13 — storyId → { title, epic } map built from the plan's epic
   * structure. Powers the Story view: substitutes raw UUIDs with story
   * titles and groups commits Epic → Wave. Absent → Story view still works
   * but falls back to short-hash handles and Epic-Id-trailer grouping.
   */
  storyMap?: StoryMap;
}) {
  const { data, isLoading, error } = useGitGraph(appId, githubRepoUrl);
  const graph = useMemo(() => (data ? buildGraph(data) : null), [data]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  // 2026-06-13 — Story view (grouped, plain-language) is the default for
  // non-technical operators; Developer view is the SourceTree-style lane graph.
  const [viewMode, setViewMode] = useState<'story' | 'developer'>('story');
  const [showMachine, setShowMachine] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const planBranchName = planSlug ? `plan/${planSlug}` : null;
  const planBranchExists = !!(
    planBranchName && graph?.branches.some((b) => b.name === planBranchName)
  );
  // Default: when the plan-branch exists, scope to it; otherwise show all.
  const [showAll, setShowAll] = useState(false);

  if (!appId) {
    return (
      <EmptyState
        title="No GitHub repo linked"
        body="This plan isn't paired with a futurator-repos GitHub repository — likely a pre-App/Plan v1 plan whose working directory exists only on EC2."
      />
    );
  }

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 80,
          color: 'var(--text-mute)',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Loader2 size={14} className="animate-spin" />
        Loading commits…
      </div>
    );
  }

  if (error) {
    const err = error as Error & { status?: number };
    if (err.status === 404) {
      return (
        <EmptyState
          title="Repo not found on GitHub"
          body={`No repository at github.com/futurator-repos/${appId}. The App may have been created before GitHub-backed apps shipped, or the repo was deleted.`}
        />
      );
    }
    return (
      <EmptyState title="Failed to load GitGraph" body={err.message || 'GitHub request failed.'} />
    );
  }

  if (!data || !graph || graph.commits.length === 0) {
    return (
      <EmptyState
        title="No commits yet"
        body="The repo exists but has no commits — push something to see the graph populate."
      />
    );
  }

  // 2026-05-19 — scope filter. When the plan-branch exists and `showAll`
  // is off, hide commits that aren't on the plan's branch lane (i.e. only
  // show this plan's commits, not the App's full history). When the
  // plan-branch is absent (legacy or pre-commit) the toggle is hidden and
  // we show everything.
  const planBranchLane = planBranchExists
    ? (graph.branches.find((b) => b.name === planBranchName)?.lane ?? null)
    : null;
  const isPlanScoped = planBranchExists && !showAll;
  const filteredCommits = isPlanScoped
    ? graph.commits.filter((c) => c.lane === planBranchLane)
    : graph.commits;
  const commits = filteredCommits;
  const { branches, prCount } = graph;
  const { paths, dots } = buildPaths(commits, branches);
  const totalH = commits.length * ROW_H + 6;
  // 2026-06-13 — graph width grows with the deepest lane in view so wide
  // fan-outs (one wip/ lane per parallel story) aren't clipped by a fixed
  // 132px SVG box. The flex container's overflowX:auto then lets the
  // operator scroll horizontally to see the full branching extent.
  const maxLane = commits.reduce((m, c) => Math.max(m, c.lane), 0);
  const graphW = Math.max(GRAPH_W, LANE_PAD * 2 + maxLane * LANE_W + 8);

  // 2026-06-13 — Story view data: classify every commit into a plain-language
  // step, hide machine bookkeeping unless opted-in, and group Epic → Wave.
  const metas = commits.map((c) => classifyCommit(c.fullMessage, storyMap));
  const visible = commits
    .map((commit, origIndex) => ({ commit, meta: metas[origIndex], origIndex }))
    .filter((v) => showMachine || !v.meta.isMachine);
  const storyGroups = groupByEpicWave(visible.map((v) => v.meta));
  const machineCount = metas.filter((m) => m.isMachine).length;
  const active = commits[activeIdx] ?? commits[0] ?? graph.commits[0];

  // 2026-05-19 — does the current Plan-Id trailer appear anywhere?
  // Counts the commits in the loaded page (limit 40 by default). Server-
  // side countResidualPlanCommits is authoritative; this is a UI hint.
  const planIdHits = planId
    ? graph.commits.filter((c) => c.fullMessage.includes(`Plan-Id: ${planId}`)).length
    : 0;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
        color: 'var(--foreground)',
      }}
    >
      {/* 2026-05-19 — scope banner. Explains what the operator is seeing
          and why. Only renders when plan-scoping is meaningful (planSlug
          provided). Legacy plans (no slug) see no banner — the App-scoped
          view IS their view.
       */}
      {planSlug && (
        <div
          style={{
            padding: '8px 14px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: 'var(--text-mute)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {isPlanScoped ? (
              <>
                Showing only <code style={{ color: 'var(--accent-blue)' }}>plan/{planSlug}</code> (
                {commits.length} commit{commits.length === 1 ? '' : 's'}). Other branches are
                hidden.
              </>
            ) : planBranchExists ? (
              <>
                Showing all branches. This plan&apos;s commits live on{' '}
                <code style={{ color: 'var(--accent-blue)' }}>plan/{planSlug}</code>.
              </>
            ) : (
              <>
                No <code>plan/{planSlug}</code> branch on this repo yet. Commits will appear here
                once the first story commits + pushes. If commits land directly on <code>main</code>
                , this is a pre-Plan-branching legacy plan and main&apos;s history is the App&apos;s
                history.
              </>
            )}
            {planIdHits > 0 && (
              <>
                {' '}
                <span style={{ color: 'var(--success)' }}>
                  · {planIdHits} commit{planIdHits === 1 ? '' : 's'} carry this plan&apos;s Plan-Id.
                </span>
              </>
            )}
          </span>
          {planBranchExists && (
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                marginLeft: 'auto',
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                borderRadius: 6,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                cursor: 'pointer',
              }}
            >
              {showAll ? 'Scope to this plan' : 'Show all branches'}
            </button>
          )}
        </div>
      )}
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <GitBranch size={14} />
        <a
          href={data.repo.html_url}
          target="_blank"
          rel="noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            fontSize: 13,
            color: 'var(--foreground)',
            textDecoration: 'none',
          }}
        >
          futurator-repos / <strong>{data.repo.name}</strong>
        </a>
        <span style={{ fontSize: 12, color: 'var(--text-mute)', flex: 1, minWidth: 0 }}>
          {data.repo.description || planName}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-mute)',
          }}
        >
          {branches.length} branch{branches.length === 1 ? '' : 'es'} · {commits.length} commit
          {commits.length === 1 ? '' : 's'} · {prCount} PR{prCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* 2026-06-13 — view toolbar: Story (grouped, friendly) vs Developer
          (lane graph), plus the machine-commit reveal in Story view. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 14px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 2,
            background: 'var(--bg-elev)',
            borderRadius: 8,
            padding: 2,
          }}
        >
          {(['story', 'developer'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setViewMode(m)}
              style={{
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 500,
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: viewMode === m ? 'var(--accent-blue)' : 'transparent',
                color: viewMode === m ? '#fff' : 'var(--text-mute)',
                transition: 'background 120ms',
              }}
            >
              {m === 'story' ? 'Story view' : 'Developer view'}
            </button>
          ))}
        </div>
        {viewMode === 'story' ? (
          <>
            <span style={{ fontSize: 12, color: 'var(--text-mute)', flex: 1, minWidth: 0 }}>
              How this app was built, step by step — grouped by epic and wave.
            </span>
            {machineCount > 0 && (
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--text-mute)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={showMachine}
                  onChange={(e) => setShowMachine(e.target.checked)}
                />
                Show machine commits ({machineCount})
              </label>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {branches.map((b) => (
              <Chip key={b.name} bg={b.tint} fg={b.color}>
                <Dot color={b.color} />
                {b.name}
                <span style={{ opacity: 0.55, marginLeft: 2 }}>{b.count}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>

      {viewMode === 'developer' ? (
        /* Graph + rows (SourceTree-style lane view) */
        <div style={{ display: 'flex', overflowX: 'auto' }}>
          <div style={{ flexShrink: 0 }}>
            <svg
              width={graphW}
              height={totalH}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: paths.join('') + dots.join('') }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid var(--border)' }}>
            {commits.map((c, i) => (
              <CommitRow
                key={c.sha}
                commit={c}
                branches={branches}
                isLast={i === commits.length - 1}
                isActive={i === activeIdx}
                isHead={branches.find((b) => b.name === c.branchHead)?.isDefault ?? false}
                onClick={() => setActiveIdx(i)}
              />
            ))}
          </div>
        </div>
      ) : (
        <StoryView
          groups={storyGroups}
          visible={visible}
          activeOrigIdx={activeIdx}
          collapsed={collapsed}
          onToggle={toggleCollapse}
          onPick={setActiveIdx}
        />
      )}

      {/* Detail panel */}
      <CommitDetail commit={active} branches={branches} />
    </div>
  );
}

// ── Story view (grouped, plain-language) ───────────────────────────

type VisibleCommit = { commit: GraphCommit; meta: CommitMeta; origIndex: number };

function waveBadges(metas: CommitMeta[]) {
  const stories = metas.filter((m) => m.kind === 'story').length;
  return {
    stories,
    merged: metas.some((m) => m.kind === 'merge'),
    buildFixed: metas.some((m) => m.kind === 'build-fix'),
    vqaChecked: metas.some((m) => m.kind === 'vqa'),
    vqaFixed: metas.some((m) => m.kind === 'vqa-fix'),
  };
}

function StoryView({
  groups,
  visible,
  activeOrigIdx,
  collapsed,
  onToggle,
  onPick,
}: {
  groups: EpicGroup[];
  visible: VisibleCommit[];
  activeOrigIdx: number;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onPick: (origIndex: number) => void;
}) {
  if (visible.length === 0) {
    return (
      <div style={{ padding: 28, textAlign: 'center', fontSize: 13, color: 'var(--text-mute)' }}>
        No commits to show.
      </div>
    );
  }
  return (
    <div>
      {groups.map((g) => {
        const epicKey = `e:${g.epicId ?? 'setup'}`;
        const epicCollapsed = collapsed.has(epicKey);
        const storyTotal = g.waves
          .flatMap((w) => w.indices.map((i) => visible[i].meta))
          .filter((m) => m.kind === 'story').length;
        return (
          <div key={epicKey} style={{ borderBottom: '1px solid var(--border)' }}>
            {/* Epic header */}
            <button
              type="button"
              onClick={() => onToggle(epicKey)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 14px',
                background: 'var(--surface)',
                border: 'none',
                borderBottom: epicCollapsed ? 'none' : '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {epicCollapsed ? (
                <ChevronRight size={15} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              ) : (
                <ChevronDown size={15} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 15, flexShrink: 0 }}>{g.epicId ? '🏛' : '⚙️'}</span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                {g.epicTitle}
              </span>
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-mute)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {storyTotal > 0
                  ? `${storyTotal} ${storyTotal === 1 ? 'story' : 'stories'}`
                  : `${g.commitCount} ${g.commitCount === 1 ? 'step' : 'steps'}`}
              </span>
            </button>

            {!epicCollapsed &&
              g.waves.map((w) => {
                const waveKey = `w:${g.epicId ?? 'setup'}:${w.wave ?? 'none'}`;
                const waveCollapsed = collapsed.has(waveKey);
                const metas = w.indices.map((i) => visible[i].meta);
                const b = waveBadges(metas);
                const isSetup = g.epicId === null;
                return (
                  <div key={waveKey}>
                    {/* Wave subheader — hidden for the Setup group (no waves) */}
                    {!isSetup && w.wave !== null && (
                      <button
                        type="button"
                        onClick={() => onToggle(waveKey)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '7px 14px 7px 30px',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {waveCollapsed ? (
                          <ChevronRight
                            size={13}
                            style={{ color: 'var(--text-mute)', flexShrink: 0 }}
                          />
                        ) : (
                          <ChevronDown
                            size={13}
                            style={{ color: 'var(--text-mute)', flexShrink: 0 }}
                          />
                        )}
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--text-dim)',
                          }}
                        >
                          Wave {w.wave}
                        </span>
                        {b.stories > 0 && <WaveTag>{b.stories} built</WaveTag>}
                        {b.merged && <WaveTag>🔀 merged</WaveTag>}
                        {b.buildFixed && <WaveTag tone="warn">🔧 auto-fixed</WaveTag>}
                        {b.vqaFixed && <WaveTag tone="warn">🎨 visual fix</WaveTag>}
                        {b.vqaChecked && <WaveTag tone="ok">👁️ checked</WaveTag>}
                      </button>
                    )}
                    {!waveCollapsed &&
                      w.indices.map((vi) => {
                        const v = visible[vi];
                        return (
                          <StoryStepRow
                            key={v.commit.sha}
                            v={v}
                            indent={isSetup ? 30 : 50}
                            active={v.origIndex === activeOrigIdx}
                            onClick={() => onPick(v.origIndex)}
                          />
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function WaveTag({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' }) {
  const c =
    tone === 'ok'
      ? { bg: 'rgba(34,197,94,0.14)', fg: '#22c55e' }
      : tone === 'warn'
        ? { bg: 'rgba(209,165,79,0.16)', fg: '#d1a54f' }
        : { bg: 'var(--bg-elev)', fg: 'var(--text-mute)' };
  return (
    <span
      style={{
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        padding: '1px 6px',
        borderRadius: 9,
        background: c.bg,
        color: c.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function StoryStepRow({
  v,
  indent,
  active,
  onClick,
}: {
  v: VisibleCommit;
  indent: number;
  active: boolean;
  onClick: () => void;
}) {
  const { commit, meta } = v;
  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: `8px 14px 8px ${indent}px`,
        cursor: 'pointer',
        background: active ? 'var(--surface)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 0 var(--accent-blue)' : 'none',
        transition: 'background 120ms',
      }}
    >
      <span style={{ fontSize: 14, flexShrink: 0, width: 18, textAlign: 'center' }}>
        {meta.icon}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: meta.isMachine ? 'var(--text-mute)' : 'var(--foreground)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {meta.label}
      </span>
      <a
        href={commit.htmlUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--text-mute)',
          textDecoration: 'none',
          flexShrink: 0,
        }}
      >
        {commit.shortSha}
      </a>
      <span
        style={{
          fontSize: 11.5,
          color: 'var(--text-mute)',
          width: 92,
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {commit.whenLabel}
      </span>
    </div>
  );
}

// ── Commit row ──────────────────────────────────────────────────────

function CommitRow({
  commit,
  branches,
  isLast,
  isActive,
  isHead,
  onClick,
}: {
  commit: GraphCommit;
  branches: BranchInfo[];
  isLast: boolean;
  isActive: boolean;
  isHead: boolean;
  onClick: () => void;
}) {
  const branch = branches.find((b) => b.name === commit.branchHead);
  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = 'var(--surface)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = 'transparent';
      }}
      style={{
        height: ROW_H,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        cursor: 'pointer',
        background: isActive ? 'var(--surface)' : 'transparent',
        boxShadow: isActive ? 'inset 2px 0 0 var(--accent-blue)' : 'none',
        borderBottom: isLast ? 'none' : '1px solid var(--border)',
        transition: 'background 120ms',
      }}
    >
      {(branch || commit.pr) && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {branch && (
            <Chip bg={branch.tint} fg={branch.color}>
              <Dot color={branch.color} />
              {isHead ? `HEAD ▸ ${branch.name}` : branch.name}
            </Chip>
          )}
          {commit.pr && <PrChip pr={commit.pr} />}
        </div>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {commit.message}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-mute)',
          flexShrink: 0,
        }}
      >
        {commit.shortSha}
      </span>
      <span
        style={{
          fontSize: 12,
          color: 'var(--text-mute)',
          width: 100,
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {commit.whenLabel}
      </span>
    </div>
  );
}

// ── Commit detail panel ────────────────────────────────────────────

function CommitDetail({ commit, branches }: { commit: GraphCommit; branches: BranchInfo[] }) {
  const branch = branches.find((b) => b.lane === commit.lane);
  return (
    <div
      style={{
        background: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: branch?.color ?? 'var(--text-mute)',
            marginTop: 7,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <a
              href={commit.htmlUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--foreground)',
                textDecoration: 'none',
              }}
            >
              {commit.shortSha}
            </a>
            {commit.branchHead && branch && (
              <Chip bg={branch.tint} fg={branch.color}>
                <Dot color={branch.color} />
                {commit.branchHead}
              </Chip>
            )}
            {commit.pr && <PrChip pr={commit.pr} />}
          </div>
          <div style={{ fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>{commit.message}</div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-mute)',
              marginTop: 6,
              fontFamily: 'var(--font-mono)',
            }}
          >
            @{commit.authorName} · {commit.whenLabel}
            {branch && (
              <>
                {' · on '}
                <span style={{ color: branch.color }}>{branch.name}</span>
              </>
            )}
          </div>
          {commit.parents.length > 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-mute)',
                marginTop: 8,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span>parents:</span>
              {commit.parents.map((pid) => (
                <span
                  key={pid}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 10,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-dim)',
                  }}
                >
                  {pid.slice(0, 7)}
                </span>
              ))}
            </div>
          )}
          {commit.pr && (
            <div
              style={{
                marginTop: 10,
                padding: '10px 12px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>{commit.pr.title}</div>
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  marginTop: 6,
                  fontSize: 12,
                  color: 'var(--text-mute)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <span>
                  #{commit.pr.number} · {commit.pr.head.ref} → {commit.pr.base.ref}
                </span>
                <a
                  href={commit.pr.html_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}
                >
                  open on GitHub ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────

function Chip({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 10,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        background: bg,
        color: fg,
      }}
    >
      {children}
    </span>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

function PrChip({ pr }: { pr: GitHubPullRequest }) {
  const merged = pr.merged_at != null;
  const closedNotMerged = pr.state === 'closed' && !merged;
  const map = merged
    ? { bg: 'rgba(127,119,221,.16)', fg: '#a78bfa', glyph: '●', label: 'merged' }
    : closedNotMerged
      ? { bg: 'rgba(226,75,74,.16)', fg: '#ef4444', glyph: '×', label: 'closed' }
      : { bg: 'rgba(34,197,94,.16)', fg: '#22c55e', glyph: '○', label: 'open' };
  return (
    <Chip bg={map.bg} fg={map.fg}>
      {map.glyph} #{pr.number} {map.label}
    </Chip>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        padding: 40,
        textAlign: 'center',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--foreground)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}
