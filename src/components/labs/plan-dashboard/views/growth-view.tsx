'use client';

/**
 * Skills & Growth view — pacman1 UX pass (2026-06-12).
 *
 * The plan-scoped lens on the three intelligence subsystems, designed so
 * the operator can VERIFY each by clicking through to primary evidence:
 *
 *   [SKILLS]    — which skills the agents activated during this plan
 *                 (from the timing forensic's skills section), expandable
 *                 to the per-job activations.
 *   [LESSONS]   — reflector proposals for this app: what each run taught
 *                 us, its evidence, and the approve/decline lifecycle that
 *                 turns a lesson into a CLAUDE.md rule or a skill for
 *                 future runs.
 *   [KNOWLEDGE] — compact compiler summary (articles, coverage) linking
 *                 to the Graph tab's knowledge layer.
 *
 * Honest empty states everywhere: an empty panel says WHY it's empty and
 * what makes it fill (these subsystems only gained real output on
 * 2026-06-12 — C1/G1/R1).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GraduationCap,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useReflections, useReflectionDecision } from '@/hooks/use-reflections';
import { computeCoverage } from '@/lib/graph-insights';

const S3_KNOWLEDGE = 'https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live';

interface ForensicSkills {
  activatedSkills?: Array<{ skill: string; source: string; activationCount: number }>;
  perJob?: Array<{ jobId: string; skills?: Array<{ skill: string; source: string }> }>;
}

interface GrowthProps {
  planId: string;
  /** appId / projectSlug — partition key for reflections + knowledge mirror. */
  projectSlug: string | null;
  onOpenGraph?: () => void;
}

export function GrowthView({ planId, projectSlug, onOpenGraph }: GrowthProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
      <SkillsPanel planId={planId} />
      <LessonsPanel projectSlug={projectSlug} planId={planId} />
      <KnowledgePanel projectSlug={projectSlug} onOpenGraph={onOpenGraph} />
    </div>
  );
}

// ── Skills ──────────────────────────────────────────────────────────

function SkillsPanel({ planId }: { planId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['plan-forensic-skills', planId],
    queryFn: () => api.get<{ skills?: ForensicSkills }>(`/plans/${planId}/timing/forensic`),
    staleTime: 60_000,
  });
  const [openSkill, setOpenSkill] = useState<string | null>(null);

  const skills = data?.skills?.activatedSkills ?? [];
  const perJob = data?.skills?.perJob ?? [];

  const jobsForSkill = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const j of perJob) {
      for (const s of j.skills ?? []) {
        const arr = m.get(s.skill) ?? [];
        arr.push(j.jobId);
        m.set(s.skill, arr);
      }
    }
    return m;
  }, [perJob]);

  return (
    <Panel
      icon={<Sparkles size={15} />}
      title="Skills the agents used"
      subtitle="Specialized expertise (Anthropic, org, or project skills) the agents activated while building this plan. Click a skill for who used it."
    >
      {isLoading && <Loading text="Loading skill activations…" />}
      {error && <ErrorLine text="Couldn't load the plan forensic (skill data rides on it)." />}
      {!isLoading && !error && skills.length === 0 && (
        <Empty text="No skill was activated during this plan. Agents had the skill manifest available but never invoked one — that's a real signal, not a missing feature." />
      )}
      {skills.map((s) => {
        const open = openSkill === s.skill;
        const jobs = jobsForSkill.get(s.skill) ?? [];
        return (
          <div key={s.skill} style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => setOpenSkill(open ? null : s.skill)}
              aria-expanded={open}
              style={rowBtn}
            >
              {open ? (
                <ChevronDown size={13} style={{ color: 'var(--text-mute)' }} />
              ) : (
                <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />
              )}
              <code style={{ fontSize: 12.5, color: 'var(--foreground)' }}>{s.skill}</code>
              <SourceChip source={s.source} />
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--accent-blue)',
                }}
              >
                ×{s.activationCount} activation{s.activationCount === 1 ? '' : 's'}
              </span>
            </button>
            {open && (
              <div
                style={{ padding: '4px 18px 14px 38px', fontSize: 12, color: 'var(--text-dim)' }}
              >
                {jobs.length > 0 ? (
                  <>
                    <div style={{ marginBottom: 6, color: 'var(--text-mute)', fontSize: 11 }}>
                      Activated in {jobs.length} agent job{jobs.length === 1 ? '' : 's'} — find the
                      full session in Hierarchy by job id:
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {jobs.map((j) => (
                        <code
                          key={j}
                          style={{
                            fontSize: 10.5,
                            padding: '2px 8px',
                            border: '1px solid var(--border-2)',
                            borderRadius: 4,
                            color: 'var(--text-dim)',
                          }}
                        >
                          {j.slice(0, 8)}
                        </code>
                      ))}
                    </div>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-mute)' }}>
                    Per-job attribution not recorded for this run.
                  </span>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-mute)' }}>
                  Proof in code: every story commit carries a <code>Skills-Used:</code> trailer —
                  grep the repo&apos;s git log for <code>{s.skill}</code>.
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function SourceChip({ source }: { source: string }) {
  const color =
    source === 'anthropic-official'
      ? 'var(--accent-blue)'
      : source === 'org'
        ? 'var(--warning)'
        : 'var(--success)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 7px',
      }}
    >
      {source}
    </span>
  );
}

// ── Lessons (Reflector) ─────────────────────────────────────────────

function LessonsPanel({ projectSlug, planId }: { projectSlug: string | null; planId: string }) {
  const { data, isLoading, error } = useReflections(projectSlug ? { projectSlug } : {});
  const decide = useReflectionDecision();
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    // Plan-scoped first, then other lessons for the same app.
    return [...all].sort((a, b) => {
      const ap = a.planId === planId ? 0 : 1;
      const bp = b.planId === planId ? 0 : 1;
      return ap - bp || (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }, [data, planId]);

  return (
    <Panel
      icon={<GraduationCap size={15} />}
      title="Lessons learned (Reflector)"
      subtitle="After a plan completes, the Reflector distills what the run taught us into proposals. Approving one turns it into a CLAUDE.md rule or a skill that every future agent run loads."
    >
      {isLoading && <Loading text="Loading lessons…" />}
      {error && <ErrorLine text="Couldn't load reflections." />}
      {!isLoading && !error && items.length === 0 && (
        <Empty text="No lessons yet. The Reflector fires once when a plan reaches review/delivered — its first real proposals will appear here (the reflector brain went live 2026-06-12; earlier runs predate it)." />
      )}
      {items.map((r) => {
        const open = openId === r.id;
        const isThisPlan = r.planId === planId;
        return (
          <div key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => setOpenId(open ? null : r.id)}
              style={rowBtn}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown size={13} style={{ color: 'var(--text-mute)' }} />
              ) : (
                <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />
              )}
              <ScopeChip scope={r.scope} dim={!isThisPlan} />
              <span
                style={{
                  flex: 1,
                  fontSize: 12.5,
                  color: 'var(--text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'left',
                }}
              >
                {r.content}
              </span>
              <TargetChip target={r.target} />
              <StatusChip status={r.status} />
            </button>
            {open && (
              <div
                style={{
                  padding: '4px 18px 16px 38px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <Detail label="The lesson (exact content that would be applied)">
                  <pre style={preStyle}>{r.content}</pre>
                </Detail>
                <Detail label="Why (rationale)">
                  <span style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    {r.rationale}
                  </span>
                </Detail>
                {r.evidence && r.evidence.length > 0 && (
                  <Detail label="Evidence — what taught it">
                    <ul
                      style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text-dim)' }}
                    >
                      {r.evidence.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </Detail>
                )}
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    fontSize: 11,
                    color: 'var(--text-mute)',
                  }}
                >
                  <span>confidence {(r.confidence * 100).toFixed(0)}%</span>
                  {r.skillName && (
                    <span>
                      skill: <code>{r.skillName}</code>
                    </span>
                  )}
                  <span>
                    plan {r.planId === planId ? 'this plan' : (r.planId || '').slice(0, 18)}
                  </span>
                </div>
                {r.status === 'pending' && projectSlug && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ projectSlug, id: r.id, decision: 'confirm' })}
                      style={miniBtn('var(--success)', decide.isPending)}
                    >
                      Approve — apply it
                    </button>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ projectSlug, id: r.id, decision: 'decline' })}
                      style={miniBtn('var(--destructive)', decide.isPending)}
                    >
                      Decline
                    </button>
                  </div>
                )}
                {r.status === 'confirmed' && (
                  <span style={{ fontSize: 11.5, color: 'var(--success)' }}>
                    ✓ Applied — future agent runs in this project load this automatically.
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function ScopeChip({ scope, dim }: { scope: string; dim?: boolean }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: dim ? 'var(--text-faint)' : 'var(--accent-purple)',
        border: '1px solid var(--border-2)',
        borderRadius: 3,
        padding: '2px 6px',
        flexShrink: 0,
      }}
    >
      {scope}
    </span>
  );
}

function TargetChip({ target }: { target: string }) {
  const label =
    target === 'project-claude-md'
      ? 'CLAUDE.md'
      : target === 'project-skill'
        ? 'project skill'
        : target === 'org-skill'
          ? 'org skill'
          : target;
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--accent-blue)',
        flexShrink: 0,
      }}
    >
      → {label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const color =
    status === 'confirmed'
      ? 'var(--success)'
      : status === 'declined'
        ? 'var(--destructive)'
        : status === 'deferred'
          ? 'var(--text-mute)'
          : 'var(--warning)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color,
        border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 7px',
        flexShrink: 0,
      }}
    >
      {status === 'confirmed' ? 'applied' : status}
    </span>
  );
}

// ── Knowledge summary ───────────────────────────────────────────────

function KnowledgePanel({
  projectSlug,
  onOpenGraph,
}: {
  projectSlug: string | null;
  onOpenGraph?: () => void;
}) {
  const { data } = useQuery({
    queryKey: ['growth-graph-snapshot', projectSlug],
    enabled: !!projectSlug,
    queryFn: async () => {
      const res = await fetch(
        `${S3_KNOWLEDGE}/${encodeURIComponent(projectSlug!)}/_graph/graph-snapshot.json?t=${Date.now()}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        generatedAt: string;
        nodes: Array<{
          id: string;
          kind?: string;
          type?: string;
          summary?: string;
          maturity?: number;
        }>;
        edges: Array<{ source: string; target: string; type: string }>;
      }>;
    },
    retry: false,
    staleTime: 60_000,
  });

  const coverage = data ? computeCoverage(data.nodes) : null;

  return (
    <Panel
      icon={<BookOpenText size={15} />}
      title="Project knowledge (Compiler)"
      subtitle="After every story, the knowledge compiler writes a wiki article per touched file and syncs the graph. This is what future agents read instead of re-deriving the codebase."
    >
      <div
        style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: '12px 18px',
        }}
      >
        {coverage ? (
          <>
            <Stat label="articles" value={`${coverage.filesWithArticle}/${coverage.files} files`} />
            <Stat
              label="coverage"
              value={`${coverage.coveragePct}%`}
              good={coverage.coveragePct >= 70}
            />
            <Stat label="functions mapped" value={String(coverage.functions)} />
            <Stat
              label="last sync"
              value={data ? new Date(data.generatedAt).toLocaleString() : '—'}
            />
          </>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>
            No knowledge graph yet — it appears after the first story of the next run compiles.
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {projectSlug && (
            <a
              href={`${S3_KNOWLEDGE}/${encodeURIComponent(projectSlug)}/index.md`}
              target="_blank"
              rel="noopener noreferrer"
              style={linkBtn}
            >
              Article index <ExternalLink size={10} />
            </a>
          )}
          {onOpenGraph && (
            <button type="button" onClick={onOpenGraph} style={{ ...linkBtn, cursor: 'pointer' }}>
              Open the graph →
            </button>
          )}
        </span>
      </div>
    </Panel>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color:
            good === undefined ? 'var(--foreground)' : good ? 'var(--success)' : 'var(--warning)',
        }}
      >
        {value}
      </span>
    </span>
  );
}

// ── Shared shells ───────────────────────────────────────────────────

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Panel({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <header style={{ padding: '14px 18px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--accent-blue)', marginTop: 2 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{title}</div>
          <div
            style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2, lineHeight: 1.45 }}
          >
            {subtitle}
          </div>
        </div>
      </header>
      {children}
    </section>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 18px 14px',
        color: 'var(--text-mute)',
        fontSize: 12,
      }}
    >
      <Loader2 size={12} className="animate-spin" /> {text}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{ padding: '0 18px 16px', color: 'var(--text-mute)', fontSize: 12, lineHeight: 1.5 }}
    >
      {text}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ padding: '0 18px 16px', color: 'var(--destructive)', fontSize: 12 }}>{text}</div>
  );
}

const rowBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 18px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '9px 12px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--accent-blue)',
  borderRadius: 4,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  color: 'var(--foreground)',
  lineHeight: 1.5,
};

const linkBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 11,
  padding: '4px 10px',
  border: '1px solid var(--border-2)',
  borderRadius: 5,
  color: 'var(--text-dim)',
  background: 'transparent',
  textDecoration: 'none',
};

function miniBtn(color: string, busy: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '6px 12px',
    border: `1px solid ${color}`,
    borderRadius: 5,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    color,
    fontWeight: 500,
    cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy ? 0.6 : 1,
  };
}
