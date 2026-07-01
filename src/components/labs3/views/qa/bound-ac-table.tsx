'use client';

/**
 * Bound-AC table — the centerpiece of Labs3 QA.
 *
 * Groups acceptance criteria from StoryNodeRow[] by:
 *   cohort.epicTitle  →  story.title  →  BoundAcceptanceCriterion
 *
 * Each AC row shows:
 *   AC id  |  text (2-line clamp)  |  acClass badge  |  testRef  |  status
 *
 * Clicking a row expands it in place to reveal:
 *   - Full AC text (or Given/When/Then breakdown)
 *   - testRef, testKind, lastRunSha, lastRunAt, detail (failure message)
 *
 * Read-only — no send-back, no accept actions. The pipeline executor
 * writes testBinding states; this view only reads them.
 *
 * StatusChip: passing ✓ | failing ✗ | bound ○ | unbound dim
 * AcClass badge replaces LevelChip: DET | ADV | SEC
 */

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  AcClass,
  BoundAcceptanceCriterion,
  StoryNodeRow,
  TestBindingStatus,
} from '@/types/plan-spec';

// ── Group builder ────────────────────────────────────────────────────

interface EpicGroup {
  epicTitle: string;
  stories: Array<{
    storyId: string;
    title: string;
    state: StoryNodeRow['state'];
    acs: BoundAcceptanceCriterion[];
  }>;
}

function buildGroups(stories: StoryNodeRow[]): EpicGroup[] {
  const byEpic = new Map<string, EpicGroup>();
  for (const story of stories) {
    const epicTitle = story.cohort.epicTitle ?? story.cohort.epicId;
    if (!byEpic.has(epicTitle)) {
      byEpic.set(epicTitle, { epicTitle, stories: [] });
    }
    byEpic.get(epicTitle)!.stories.push({
      storyId: story.storyId,
      title: story.title,
      state: story.state,
      acs: story.acceptanceCriteria,
    });
  }
  return [...byEpic.values()];
}

// ── StatusChip — testBinding.status ─────────────────────────────────

const STATUS_META: Record<TestBindingStatus, { label: string; color: string }> = {
  passing: { label: 'passing', color: 'var(--success)' },
  failing: { label: 'failing', color: 'var(--destructive)' },
  bound: { label: 'bound', color: 'var(--accent-blue)' },
  unbound: { label: 'unbound', color: 'var(--text-mute)' },
};

function StatusChip({ status }: { status: TestBindingStatus }) {
  const meta = STATUS_META[status] ?? { label: status, color: 'var(--text-mute)' };
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 50%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

// ── AcClass badge (replaces L0/L1/L2 LevelChip) ─────────────────────

const AC_CLASS_META: Record<AcClass, { label: string; color: string; title: string }> = {
  deterministic: {
    label: 'DET',
    color: 'var(--text-dim)',
    title: 'Deterministic — gates story completion via bound vitest',
  },
  'advisory-taste': {
    label: 'ADV',
    color: 'var(--accent-blue)',
    title: 'Advisory taste — operator note; never causes retries',
  },
  'advisory-security': {
    label: 'SEC',
    color: 'var(--accent-purple)',
    title: 'Advisory security — can block on a reviewer fail',
  },
};

function AcClassBadge({ acClass }: { acClass: AcClass }) {
  const meta = AC_CLASS_META[acClass] ?? {
    label: acClass.slice(0, 3).toUpperCase(),
    color: 'var(--text-mute)',
    title: acClass,
  };
  return (
    <span
      title={meta.title}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 55%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
        borderRadius: 3,
        padding: '2px 6px',
      }}
    >
      {meta.label}
    </span>
  );
}

// ── Expander detail ──────────────────────────────────────────────────

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8.5,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
            marginBottom: 4,
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function GwtLine({ prefix, text }: { prefix: string; text: string }) {
  const color =
    prefix === 'Given'
      ? 'var(--text-mute)'
      : prefix === 'When'
        ? 'var(--accent-blue)'
        : 'var(--success)';
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          minWidth: 40,
          marginTop: 2,
          flexShrink: 0,
        }}
      >
        {prefix}
      </span>
      <span style={{ color: 'var(--foreground)', flex: 1 }}>{text}</span>
    </div>
  );
}

function AcDetail({ ac }: { ac: BoundAcceptanceCriterion }) {
  const { testBinding } = ac;
  const hasGwt = ac.given || ac.when || ac.then;

  return (
    <div
      style={{
        padding: '12px 18px 14px 42px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Full criterion text — GWT breakdown preferred over raw text */}
      {hasGwt ? (
        <DetailField label="Acceptance criterion (Given / When / Then)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {ac.given && <GwtLine prefix="Given" text={ac.given} />}
            {ac.when && <GwtLine prefix="When" text={ac.when} />}
            {ac.then && <GwtLine prefix="Then" text={ac.then} />}
          </div>
        </DetailField>
      ) : (
        <DetailField label="Acceptance criterion">
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--foreground)' }}>
            {ac.text}
          </p>
        </DetailField>
      )}

      {/* Test binding details */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {testBinding.testRef && (
          <DetailField label="Test ref">
            <code style={{ fontSize: 11, color: 'var(--accent-blue)' }}>{testBinding.testRef}</code>
          </DetailField>
        )}
        {testBinding.testKind && (
          <DetailField label="Test kind">
            <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>{testBinding.testKind}</code>
          </DetailField>
        )}
        {testBinding.lastRunSha && (
          <DetailField label="Last run SHA">
            <code
              style={{ fontSize: 10.5, color: 'var(--text-dim)', letterSpacing: '0.04em' }}
              title={testBinding.lastRunSha}
            >
              {testBinding.lastRunSha.slice(0, 10)}
            </code>
          </DetailField>
        )}
        {testBinding.lastRunAt && (
          <DetailField label="Last run">
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }} title={testBinding.lastRunAt}>
              {relTime(testBinding.lastRunAt)}
            </span>
          </DetailField>
        )}
        {ac.verify && (
          <DetailField label="Verify via">
            <code style={{ fontSize: 11, color: 'var(--text-mute)' }}>{ac.verify}</code>
          </DetailField>
        )}
        {ac.needsBrowser && (
          <DetailField label="">
            <span style={{ fontSize: 11, color: 'var(--warning)', fontFamily: 'var(--font-mono)' }}>
              Needs browser
            </span>
          </DetailField>
        )}
      </div>

      {/* Detail / failure message */}
      {testBinding.detail && (
        <DetailField label={testBinding.status === 'failing' ? 'Failure detail' : 'Detail'}>
          <pre
            style={{
              margin: 0,
              padding: '7px 10px',
              fontSize: 11,
              lineHeight: 1.45,
              fontFamily: 'var(--font-mono)',
              color: testBinding.status === 'failing' ? 'var(--destructive)' : 'var(--text-dim)',
              background: 'var(--surface)',
              border: `1px solid ${testBinding.status === 'failing' ? 'color-mix(in srgb, var(--destructive) 40%, transparent)' : 'var(--border)'}`,
              borderLeft: `3px solid ${testBinding.status === 'failing' ? 'var(--destructive)' : 'var(--border-2)'}`,
              borderRadius: 4,
              whiteSpace: 'pre-wrap',
              overflowX: 'auto',
            }}
          >
            {testBinding.detail}
          </pre>
        </DetailField>
      )}
    </div>
  );
}

// ── Accordion row ────────────────────────────────────────────────────

function AcAccordionRow({
  ac,
  open,
  onToggle,
}: {
  ac: BoundAcceptanceCriterion;
  open: boolean;
  onToggle: () => void;
}) {
  const { testBinding } = ac;
  return (
    <>
      <tr
        onClick={onToggle}
        aria-expanded={open}
        style={{
          cursor: 'pointer',
          borderTop: '1px solid var(--border)',
          background: open ? 'color-mix(in srgb, var(--accent-blue) 4%, transparent)' : undefined,
        }}
        onMouseEnter={(e) => {
          if (!open)
            e.currentTarget.style.background =
              'color-mix(in srgb, var(--foreground) 3%, transparent)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        {/* Chevron + AC id */}
        <td style={{ padding: '9px 8px 9px 18px', whiteSpace: 'nowrap', width: 130 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {open ? (
              <ChevronDown size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
            ) : (
              <ChevronRight size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
            )}
            <code style={{ fontSize: 10, color: 'var(--accent-blue)', letterSpacing: '0.04em' }}>
              {ac.id}
            </code>
          </span>
        </td>

        {/* AC text — 2-line clamp */}
        <td style={{ padding: '9px 10px', color: 'var(--text-dim)', lineHeight: 1.45 }}>
          <span
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              fontSize: 12.5,
            }}
          >
            {ac.text}
          </span>
        </td>

        {/* AcClass badge */}
        <td style={{ padding: '9px 8px', textAlign: 'center', width: 60 }}>
          <AcClassBadge acClass={ac.acClass} />
        </td>

        {/* testRef (compact, truncated) */}
        <td style={{ padding: '9px 10px', width: 160, whiteSpace: 'nowrap' }}>
          {testBinding.testRef ? (
            <code
              style={{ fontSize: 10.5, color: 'var(--text-dim)', letterSpacing: '0.02em' }}
              title={testBinding.testRef}
            >
              {testBinding.testRef.length > 24
                ? testBinding.testRef.slice(0, 24) + '…'
                : testBinding.testRef}
            </code>
          ) : (
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}
            >
              —
            </span>
          )}
        </td>

        {/* Status chip */}
        <td style={{ padding: '9px 18px 9px 10px', width: 100 }}>
          <StatusChip status={testBinding.status} />
        </td>
      </tr>

      {/* Expander */}
      {open && (
        <tr>
          <td
            colSpan={5}
            style={{
              padding: 0,
              borderTop: '1px dashed var(--border)',
              background: 'color-mix(in srgb, var(--accent-blue) 2.5%, transparent)',
            }}
          >
            <AcDetail ac={ac} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Table head style helper ──────────────────────────────────────────

function headTh(extra: React.CSSProperties): React.CSSProperties {
  return {
    padding: '9px 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: 8.5,
    color: 'var(--text-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    fontWeight: 600,
    ...extra,
  };
}

// ── Main export ──────────────────────────────────────────────────────

export function BoundAcTable({ stories }: { stories: StoryNodeRow[] }) {
  const groups = useMemo(() => buildGroups(stories), [stories]);
  const [openId, setOpenId] = useState<string | null>(null);

  const totalAcs = useMemo(
    () => stories.reduce((n, s) => n + s.acceptanceCriteria.length, 0),
    [stories],
  );
  const passingAcs = useMemo(
    () =>
      stories.reduce(
        (n, s) =>
          n + s.acceptanceCriteria.filter((ac) => ac.testBinding.status === 'passing').length,
        0,
      ),
    [stories],
  );

  if (groups.length === 0) return null;

  return (
    <section
      aria-label="Bound acceptance criteria"
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 220, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            Bound acceptance criteria
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
            Every AC across all stories, with its test binding and current status. Click a row to
            see the full criterion, test ref, SHA, and failure detail.
          </div>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-mute)',
            flexShrink: 0,
          }}
        >
          {passingAcs}/{totalAcs} passing
        </span>
      </header>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 640 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={headTh({ textAlign: 'left', paddingLeft: 18, minWidth: 130 })}>id</th>
              <th style={headTh({ textAlign: 'left' })}>criterion</th>
              <th style={headTh({ textAlign: 'center', width: 60 })}>class</th>
              <th style={headTh({ textAlign: 'left', width: 160 })}>test ref</th>
              <th style={headTh({ textAlign: 'left', paddingRight: 18, width: 100 })}>status</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((epic) => (
              <Fragment key={epic.epicTitle}>
                {epic.stories.map((story) => (
                  <Fragment key={story.storyId}>
                    {/* Section header: epicTitle · storyTitle */}
                    <tr>
                      <td
                        colSpan={5}
                        style={{
                          padding: '11px 18px 5px',
                          borderTop: '1px solid var(--border)',
                          background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--accent-blue)',
                            letterSpacing: '0.1em',
                          }}
                        >
                          {epic.epicTitle}
                        </span>
                        <span
                          style={{
                            color: 'var(--text-dim)',
                            fontSize: 12.5,
                            marginLeft: 10,
                          }}
                        >
                          {story.title}
                        </span>
                      </td>
                    </tr>

                    {/* AC rows */}
                    {story.acs.map((ac) => {
                      const rowKey = `${story.storyId}:${ac.id}`;
                      return (
                        <AcAccordionRow
                          key={rowKey}
                          ac={ac}
                          open={openId === rowKey}
                          onToggle={() => setOpenId((cur) => (cur === rowKey ? null : rowKey))}
                        />
                      );
                    })}

                    {/* Empty story guard */}
                    {story.acs.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            padding: '8px 18px',
                            fontSize: 11,
                            color: 'var(--text-faint)',
                            fontStyle: 'italic',
                          }}
                        >
                          No acceptance criteria defined for this story.
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend footer */}
      <footer
        style={{
          padding: '9px 18px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          fontSize: 10.5,
          color: 'var(--text-mute)',
          alignItems: 'center',
        }}
      >
        <span>
          <AcClassBadge acClass="deterministic" /> deterministic — gates completion
        </span>
        <span>
          <AcClassBadge acClass="advisory-taste" /> advisory — operator note
        </span>
        <span>
          <AcClassBadge acClass="advisory-security" /> security advisory
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
          }}
        >
          {passingAcs}/{totalAcs} passing
        </span>
      </footer>
    </section>
  );
}

// ── Relative time helper ─────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
