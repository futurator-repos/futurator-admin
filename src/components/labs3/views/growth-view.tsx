'use client';

/**
 * Labs3 — Skills & Learnings view (B7).
 *
 * The pipeline-3 analogue of legacy growth-view: four panels that expose the
 * continuous-learning subsystems wired around the SDD/story-dev pipeline.
 *
 *   [SKILLS]     — which skills agents activated during this plan; enriched with
 *                  full catalog metadata (provenance, trust tier, description)
 *                  from useSkillCatalog alongside the per-plan forensic.
 *   [LESSONS]    — Reflector proposals scoped to this plan's app; client-sorted
 *                  so plan-scoped items surface first.
 *   [INSTINCTS]  — The instinct loop (daemon/lib observations.jsonl): distilled
 *                  candidate instincts + instincts promoted to Mycelium nodes.
 *   [GATE BLOCKS]— Live-gate audit/enforce events (gate-events.jsonl would-blocks
 *                  and actual blocks) surfaced in real time from useInstincts.
 *
 * Inline-style CSS-var idiom throughout (matches legacy growth-view, NOT
 * ReflectionInbox Tailwind). All four panels read their data independently;
 * TanStack Query deduplicates the two useInstincts(planId) calls at the cache
 * layer so only one network request fires.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  Loader2,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useSkillCatalog, type CatalogSkill } from '@/hooks/use-skill-catalog';
import { useReflections, useReflectionDecision } from '@/hooks/use-reflections';
import { useInstincts } from '@/hooks/use-instincts';
import type { DistilledInstinct, GateBlockEvent, PromotedInstinct } from '@/types/plan-spec';

// ── Component contract ────────────────────────────────────────────────────────
// The shell (PlanSpecDashboard, B2) resolves appId from the plan row and passes
// it as projectSlug — this view never self-fetches the plan.

export interface GrowthViewProps {
  planId: string;
  /** App slug — FK for reflections + skill forensic partition. */
  appId: string | null;
  /** Resolved app slug (same as appId; shell passes appId ?? ''). */
  projectSlug: string;
  onOpenGraph?: () => void;
}

export function GrowthView({ planId, projectSlug, onOpenGraph }: GrowthViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
      <SkillsPanel planId={planId} />
      <LessonsPanel projectSlug={projectSlug} planId={planId} />
      <InstinctsPanel planId={planId} />
      <GateBlocksPanel planId={planId} onOpenGraph={onOpenGraph} />
    </div>
  );
}

// ── Shared inline-style primitives ────────────────────────────────────────────

interface ForensicSkills {
  activatedSkills?: Array<{ skill: string; source: string; activationCount: number }>;
  perJob?: Array<{ jobId: string; skills?: Array<{ skill: string; source: string }> }>;
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
      <Loader2 size={12} className="animate-spin" />
      {text}
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

// ── SkillsPanel ───────────────────────────────────────────────────────────────
// Combines the plan timing/forensic (which skills were activated THIS plan) with
// the full catalog (descriptions, provenance class, trust tier, autoTrust) so the
// operator can see both WHO used what and WHAT that skill is.

function SkillsPanel({ planId }: { planId: string }) {
  const {
    data: forensic,
    isLoading: fLoading,
    error: fError,
  } = useQuery({
    queryKey: ['plan-skills-learnings', planId],
    // P3-aware route: discovers story-dev jobs by storyNodeRef.planId and reads
    // the loaded skill set off the plan-spec-graph rows. The legacy
    // /timing/forensic discovered jobs via plan.epicIds — which P3 jobs don't
    // carry — so it always came back empty for a Pipeline-3 run.
    queryFn: () => api.get<ForensicSkills>(`/plans/${planId}/skills-learnings`),
    staleTime: 60_000,
  });

  const { data: catalog } = useSkillCatalog();

  const [openSkill, setOpenSkill] = useState<string | null>(null);

  // Build name → CatalogSkill for O(1) enrichment lookups.
  const catalogMap = useMemo<Map<string, CatalogSkill>>(() => {
    const m = new Map<string, CatalogSkill>();
    for (const s of catalog?.skills ?? []) m.set(s.name, s);
    return m;
  }, [catalog?.skills]);

  const activated = forensic?.activatedSkills ?? [];

  const jobsForSkill = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const j of forensic?.perJob ?? []) {
      for (const s of j.skills ?? []) {
        const arr = m.get(s.skill) ?? [];
        arr.push(j.jobId);
        m.set(s.skill, arr);
      }
    }
    return m;
  }, [forensic?.perJob]);

  return (
    <Panel
      icon={<Sparkles size={15} />}
      title="Skills the agents used"
      subtitle="Skills (Anthropic, org, or project-evolved) the agents activated while building this plan — enriched with catalog metadata. Click a skill to see which story-dev jobs used it."
    >
      {fLoading && <Loading text="Loading skill activations…" />}
      {fError && <ErrorLine text="Couldn't load the plan forensic (skill data rides on it)." />}
      {!fLoading && !fError && activated.length === 0 && (
        <Empty text="No skill was activated during this plan. Agents had the manifest available but never invoked one — that's a real signal, not a missing feature." />
      )}
      {activated.map((s) => {
        const open = openSkill === s.skill;
        const jobs = jobsForSkill.get(s.skill) ?? [];
        const entry = catalogMap.get(s.skill);
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
              {entry?.trustTier && <TrustChip tier={entry.trustTier} />}
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
                style={{
                  padding: '4px 18px 14px 38px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
              >
                {entry?.description && (
                  <Detail label="What this skill does">
                    <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>{entry.description}</span>
                  </Detail>
                )}

                {entry && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      fontSize: 11,
                      color: 'var(--text-mute)',
                    }}
                  >
                    {entry.kind && (
                      <span>
                        kind: <code>{entry.kind}</code>
                      </span>
                    )}
                    {entry.version && (
                      <span>
                        v<code>{entry.version}</code>
                      </span>
                    )}
                    {entry.provenanceClass && <span>{entry.provenanceClass}</span>}
                    {entry.autoTrust && (
                      <span style={{ color: 'var(--success)' }}>auto-trust ✓</span>
                    )}
                  </div>
                )}

                {jobs.length > 0 ? (
                  <Detail
                    label={`Used in ${jobs.length} story-dev job${jobs.length === 1 ? '' : 's'}`}
                  >
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
                  </Detail>
                ) : (
                  <span style={{ color: 'var(--text-mute)', fontSize: 11 }}>
                    Per-job attribution not recorded for this run.
                  </span>
                )}

                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-mute)' }}>
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
  const isAppEvolved = source === 'app-evolved';
  const color = isAppEvolved
    ? 'var(--accent-purple, #a855f7)'
    : source === 'anthropic-official'
      ? 'var(--accent-blue)'
      : source === 'org'
        ? 'var(--warning)'
        : 'var(--success)';
  return (
    <span
      title={isAppEvolved ? 'Authored by the reflector loop from a ratified lesson' : undefined}
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
      {isAppEvolved ? '✦ app-evolved' : source}
    </span>
  );
}

function TrustChip({ tier }: { tier: string }) {
  const color =
    tier === 'trusted'
      ? 'var(--success)'
      : tier === 'reviewed'
        ? 'var(--accent-blue)'
        : tier === 'deprecated'
          ? 'var(--destructive)'
          : 'var(--text-mute)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        borderRadius: 3,
        padding: '2px 6px',
      }}
    >
      {tier}
    </span>
  );
}

// ── LessonsPanel ──────────────────────────────────────────────────────────────
// Identical grammar to legacy LessonsPanel; plan-scoped items sort first.

function LessonsPanel({ projectSlug, planId }: { projectSlug: string; planId: string }) {
  const { data, isLoading, error } = useReflections(projectSlug ? { projectSlug } : {});
  const decide = useReflectionDecision();
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(() => {
    const all = data?.items ?? [];
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
      subtitle="After a plan completes, the Reflector distills what the run taught us. Approving a lesson turns it into a CLAUDE.md rule or a skill that every future agent run loads."
    >
      {isLoading && <Loading text="Loading lessons…" />}
      {error && <ErrorLine text="Couldn't load reflections." />}
      {!isLoading && !error && items.length === 0 && (
        <Empty text="No lessons yet for this app. The Reflector fires once when a plan reaches review/delivered — its proposals appear here after the first completed pipeline-3 run." />
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
              <ReflectionStatusChip status={r.status} applyOutcome={r.applyOutcome} />
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
                      style={{
                        margin: 0,
                        paddingLeft: 16,
                        fontSize: 12,
                        color: 'var(--text-dim)',
                      }}
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

function ReflectionStatusChip({ status, applyOutcome }: { status: string; applyOutcome?: string }) {
  const effective = status === 'confirmed' && applyOutcome ? applyOutcome : status;
  const color =
    effective === 'applied' || (effective === 'confirmed' && !applyOutcome)
      ? 'var(--success)'
      : effective === 'failed' || effective === 'declined'
        ? 'var(--destructive)'
        : effective === 'deferred' || effective === 'noop'
          ? 'var(--text-mute)'
          : 'var(--warning)';
  const label = status === 'confirmed' && !applyOutcome ? 'applying…' : effective;
  return (
    <span
      title={
        status === 'confirmed' && !applyOutcome
          ? 'Confirmed — waiting for the daemon to land it (REFLECTOR-APPLY)'
          : undefined
      }
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
      {label}
    </span>
  );
}

// ── InstinctsPanel ────────────────────────────────────────────────────────────
// NEW: surfaces the instinct loop — distilled candidate instincts (scored from
// recurring negative-signal observations) and instincts already promoted to
// Mycelium nodes. Backed by useInstincts(planId) at 30s poll cadence.

function InstinctsPanel({ planId }: { planId: string }) {
  const { data, isLoading, error } = useInstincts(planId);
  const [openId, setOpenId] = useState<string | null>(null);

  const distilled: DistilledInstinct[] = data?.distilled ?? [];
  const promoted: PromotedInstinct[] = data?.promoted ?? [];
  const all = useMemo<Array<DistilledInstinct | PromotedInstinct>>(() => {
    // promoted first (they're the ones that graduated), then candidates
    const promotedSorted = [...promoted].sort((a, b) =>
      (b.promotedAt ?? '').localeCompare(a.promotedAt ?? ''),
    );
    const candidates = distilled.filter((d) => d.status !== 'promoted');
    return [...promotedSorted, ...candidates];
  }, [distilled, promoted]);

  return (
    <Panel
      icon={<Brain size={15} />}
      title="Instinct loop"
      subtitle="The daemon observes tool outcomes across sessions and distills recurring patterns into instincts. High-confidence ones are promoted to Mycelium — every future agent inherits them."
    >
      {isLoading && <Loading text="Loading instincts…" />}
      {error && <ErrorLine text="Couldn't load instinct feed." />}
      {!isLoading && !error && all.length === 0 && (
        <Empty text="No instincts yet. The instinct distiller runs after enough sessions accumulate observations in .pipeline/observations.jsonl — it fires automatically as the plan develops." />
      )}
      {all.map((inst) => {
        const open = openId === inst.id;
        const isPromoted = inst.status === 'promoted';
        const statusColor = isPromoted
          ? 'var(--success)'
          : inst.status === 'active'
            ? 'var(--accent-blue)'
            : 'var(--text-mute)';

        return (
          <div key={inst.id} style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => setOpenId(open ? null : inst.id)}
              aria-expanded={open}
              style={rowBtn}
            >
              {open ? (
                <ChevronDown size={13} style={{ color: 'var(--text-mute)' }} />
              ) : (
                <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />
              )}
              <EnforcementChip enforcement={inst.enforcement} />
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
                {inst.text}
              </span>
              <InstinctStatusChip status={inst.status ?? 'candidate'} color={statusColor} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-mute)',
                  flexShrink: 0,
                }}
              >
                {(inst.confidence * 100).toFixed(0)}% ({inst.support}×)
              </span>
            </button>

            {open && (
              <div
                style={{
                  padding: '4px 18px 14px 38px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
              >
                <Detail label="Instinct">
                  <pre style={preStyle}>{inst.text}</pre>
                </Detail>
                <div
                  style={{
                    display: 'flex',
                    gap: 14,
                    flexWrap: 'wrap',
                    fontSize: 11,
                    color: 'var(--text-mute)',
                  }}
                >
                  <span>
                    confidence:{' '}
                    <strong style={{ color: 'var(--foreground)' }}>
                      {(inst.confidence * 100).toFixed(0)}%
                    </strong>
                  </span>
                  <span>
                    support:{' '}
                    <strong style={{ color: 'var(--foreground)' }}>{inst.support} sessions</strong>
                  </span>
                  {inst.role && (
                    <span>
                      role: <code>{inst.role}</code>
                    </span>
                  )}
                  {inst.touchesGlob && (
                    <span>
                      scope: <code>{inst.touchesGlob}</code>
                    </span>
                  )}
                  {'promotedAt' in inst && inst.promotedAt && (
                    <span>promoted: {new Date(inst.promotedAt).toLocaleString()}</span>
                  )}
                </div>
                {isPromoted && (
                  <span style={{ fontSize: 11.5, color: 'var(--success)' }}>
                    ✓ Graduated to Mycelium — every future agent load inherits this instinct.
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

function EnforcementChip({ enforcement }: { enforcement: 'advisory' | 'gate' | 'test' }) {
  const color =
    enforcement === 'gate'
      ? 'var(--destructive)'
      : enforcement === 'test'
        ? 'var(--warning)'
        : 'var(--text-mute)';
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
        flexShrink: 0,
      }}
    >
      {enforcement}
    </span>
  );
}

function InstinctStatusChip({ status, color }: { status: string; color: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 7px',
        flexShrink: 0,
      }}
    >
      {status}
    </span>
  );
}

// ── GateBlocksPanel ───────────────────────────────────────────────────────────
// NEW: surfaces the live-gate audit/enforce decisions from gate-events.jsonl.
// Shows decisions that are 'audit' (would-block in audit mode) or 'block'
// (enforce mode hard-stop) — as well as fact-force decisions — so the operator
// can see what the pre-tool gate is catching in real time.

function GateBlocksPanel({ planId, onOpenGraph }: { planId: string; onOpenGraph?: () => void }) {
  const { data, isLoading, error } = useInstincts(planId);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const blocks: GateBlockEvent[] = data?.gateBlocks ?? [];

  // Distinguish true blocks from fact-force and audit-mode would-blocks for
  // visual clarity. Only 'block' decisions halt the agent; 'audit' are ghosts.
  const countBlocked = blocks.filter((b) => b.decision === 'block').length;
  const countAudit = blocks.filter((b) => b.decision === 'audit').length;

  return (
    <Panel
      icon={<ShieldAlert size={15} />}
      title="Gate events"
      subtitle="Live-gate decisions from gate-events.jsonl: audit (would-block in audit mode), block (enforce mode hard-stop), and fact-force (scope or risk override). These are the signals the instinct loop distills."
    >
      {isLoading && <Loading text="Loading gate events…" />}
      {error && <ErrorLine text="Couldn't load gate events." />}
      {!isLoading && !error && blocks.length === 0 && (
        <Empty text="No gate events for this plan yet. Events are written to .pipeline/gate-events.jsonl while story-dev agents run — they appear here as the pipeline dispatches stories." />
      )}
      {blocks.length > 0 && (
        <div
          style={{
            padding: '0 18px 12px',
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
            fontSize: 11,
            color: 'var(--text-mute)',
          }}
        >
          {countBlocked > 0 && (
            <span>
              <strong style={{ color: 'var(--destructive)' }}>{countBlocked}</strong> hard block
              {countBlocked === 1 ? '' : 's'}
            </span>
          )}
          {countAudit > 0 && (
            <span>
              <strong style={{ color: 'var(--warning)' }}>{countAudit}</strong> would-block
              {countAudit === 1 ? '' : 's'} (audit)
            </span>
          )}
          <span>{blocks.length} total events</span>
          {onOpenGraph && (
            <button
              type="button"
              onClick={onOpenGraph}
              style={{
                marginLeft: 'auto',
                fontSize: 11,
                padding: '3px 10px',
                border: '1px solid var(--border-2)',
                borderRadius: 5,
                color: 'var(--text-dim)',
                background: 'transparent',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Zap size={11} />
              Graph view
            </button>
          )}
        </div>
      )}

      {blocks.map((b, idx) => {
        const open = openIdx === idx;
        const decisionColor =
          b.decision === 'block'
            ? 'var(--destructive)'
            : b.decision === 'audit'
              ? 'var(--warning)'
              : b.decision === 'fact-force'
                ? 'var(--accent-purple)'
                : b.decision === 'fact-force-cleared'
                  ? 'var(--success)'
                  : 'var(--text-mute)';

        return (
          <div key={idx} style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => setOpenIdx(open ? null : idx)}
              aria-expanded={open}
              style={rowBtn}
            >
              {open ? (
                <ChevronDown size={13} style={{ color: 'var(--text-mute)' }} />
              ) : (
                <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />
              )}
              <GateDecisionChip decision={b.decision} color={decisionColor} />
              {b.risk?.tier && <GateTierChip tier={b.risk.tier} />}
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
                {b.reason ?? b.target ?? '—'}
              </span>
              {b.at && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--text-faint)',
                    flexShrink: 0,
                  }}
                >
                  {new Date(b.at).toLocaleTimeString()}
                </span>
              )}
            </button>

            {open && (
              <div
                style={{
                  padding: '4px 18px 14px 38px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
              >
                {b.reason && (
                  <Detail label="Reason">
                    <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>{b.reason}</span>
                  </Detail>
                )}
                {b.target && (
                  <Detail label="Target (file / tool / path)">
                    <code
                      style={{
                        fontSize: 11,
                        padding: '3px 8px',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                      }}
                    >
                      {b.target}
                    </code>
                  </Detail>
                )}
                {b.risk && (b.risk.score !== undefined || (b.risk.factors ?? []).length > 0) && (
                  <Detail label="Risk assessment">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
                      {b.risk.score !== undefined && (
                        <span>
                          score:{' '}
                          <strong style={{ color: 'var(--foreground)' }}>
                            {b.risk.score.toFixed(2)}
                          </strong>
                          {b.risk.tier && (
                            <span style={{ color: 'var(--text-mute)' }}> ({b.risk.tier})</span>
                          )}
                        </span>
                      )}
                      {(b.risk.factors ?? []).length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-mute)' }}>
                          {b.risk.factors!.map((f, i) => (
                            <li key={i}>{f}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Detail>
                )}
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    flexWrap: 'wrap',
                    fontSize: 11,
                    color: 'var(--text-mute)',
                  }}
                >
                  {b.session && (
                    <span>
                      session: <code>{b.session.slice(0, 8)}</code>
                    </span>
                  )}
                  {b.enforce !== undefined && (
                    <span>enforce mode: {b.enforce ? 'ON' : 'OFF (audit)'}</span>
                  )}
                  {b.at && <span>{new Date(b.at).toLocaleString()}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function GateDecisionChip({ decision, color }: { decision: string; color: string }) {
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
        flexShrink: 0,
      }}
    >
      {decision.replace(/-/g, ' ')}
    </span>
  );
}

function GateTierChip({ tier }: { tier: string }) {
  const color =
    tier === 'high'
      ? 'var(--destructive)'
      : tier === 'medium'
        ? 'var(--warning)'
        : 'var(--text-mute)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.05em',
        color,
        flexShrink: 0,
      }}
    >
      {tier}
    </span>
  );
}
