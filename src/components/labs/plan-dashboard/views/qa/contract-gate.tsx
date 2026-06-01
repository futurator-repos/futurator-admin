'use client';

/**
 * Contract Gate — PR-8d operator-approval surface for the QA test
 * contract. Renders when `report.vqa.executeStatus === 'queued-contract'`
 * (operator must approve before qa-execute runs) or `'rejected'`
 * (operator declined; show summary + Re-classify CTA).
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ OPERATOR REVIEW REQUIRED                                        │
 *   │  8 tests · L0/L1/L2 split · est $0.04 · ~40s                    │
 *   │                                                                 │
 *   │ ▸ Warnings (only when arrays non-empty)                         │
 *   │                                                                 │
 *   │ Tests                                                           │
 *   │  E1 ▸ Story title                                               │
 *   │   ✓ VT-…  [L1▾]  AC-1  "expect text"  (reason)                  │
 *   │   …                                                             │
 *   │                                                                 │
 *   │              [Reject — skip QA]   [Approve N tests · $X · ~Ns]  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Operator edits per-test level via the dropdown; per-test inclusion via
 * the checkbox. The cost/wallclock chip in the header recomputes live.
 * Approve POSTs only the included tests with their (possibly edited)
 * levels; backend's `body.tests` override path picks it up verbatim.
 */

import { useMemo, useState } from 'react';
import { Loader2, Check, X, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type {
  ContractClassifiedTest,
  QaContractDraft,
  QaReport,
  VqaTestLevel,
} from '@/types/qa-report';
import { useApproveQaContract, useRejectQaContract, useRunQaReview } from '@/hooks/use-qa-report';

// Mirror of functions/shared/services/visual-test-classifier.ts —
// duplicated client-side so the live recompute doesn't need a backend
// roundtrip. Keep in sync with the backend constants on changes.
const COST_BY_LEVEL: Record<VqaTestLevel, number> = { L0: 0, L1: 0.005, L2: 0.05 };
const WALLCLOCK_BY_LEVEL: Record<VqaTestLevel, number> = { L0: 1, L1: 5, L2: 45 };

interface Props {
  report: QaReport;
  planId: string;
}

interface DraftRow {
  test: ContractClassifiedTest;
  /** Operator-edited level (defaults to test.level). */
  level: VqaTestLevel;
  /** When false, test is excluded from the approve payload. */
  included: boolean;
}

export function ContractGate({ report, planId }: Props) {
  const contract = report.vqa.contract;
  const executeStatus = report.vqa.executeStatus;

  if (!contract) return null;
  if (executeStatus !== 'queued-contract' && executeStatus !== 'rejected') return null;

  if (executeStatus === 'rejected') {
    return <RejectedSummary contract={contract} planId={planId} />;
  }

  return <PendingContractCard contract={contract} planId={planId} />;
}

// ────────────────────────────────────────────────────────────────────
// Pending — full curation surface
// ────────────────────────────────────────────────────────────────────

function PendingContractCard({ contract, planId }: { contract: QaContractDraft; planId: string }) {
  const approve = useApproveQaContract(planId);
  const reject = useRejectQaContract(planId);

  const [rows, setRows] = useState<DraftRow[]>(() =>
    contract.classifiedTests.map((t) => ({ test: t, level: t.level, included: true })),
  );
  const [warningsOpen, setWarningsOpen] = useState(
    contract.coverageWarnings.length + contract.specificityWarnings.length > 0,
  );

  // Live cost + wallclock based on operator edits (excluded tests drop out).
  const totals = useMemo(() => {
    let cost = 0;
    let wall = 0;
    let included = 0;
    const byLevel = { L0: 0, L1: 0, L2: 0 };
    for (const r of rows) {
      if (!r.included) continue;
      cost += COST_BY_LEVEL[r.level];
      wall += WALLCLOCK_BY_LEVEL[r.level];
      byLevel[r.level] += 1;
      included += 1;
    }
    return { cost, wall, included, byLevel };
  }, [rows]);

  function setLevel(testId: string, level: VqaTestLevel) {
    setRows((prev) => prev.map((r) => (r.test.testId === testId ? { ...r, level } : r)));
  }
  function setIncluded(testId: string, included: boolean) {
    setRows((prev) => prev.map((r) => (r.test.testId === testId ? { ...r, included } : r)));
  }

  function onApprove() {
    const payload = rows
      .filter((r) => r.included)
      .map((r) => ({ id: r.test.testId, level: r.level }));
    approve.mutate({ tests: payload });
  }
  function onReject() {
    reject.mutate();
  }

  const dirty = rows.some((r, i) => r.level !== contract.classifiedTests[i].level || !r.included);
  const allEmpty = totals.included === 0;

  // Group rows by epic→story for the table layout.
  const grouped = useMemo(() => groupByEpicStory(rows), [rows]);

  return (
    <div
      style={{
        border: '1px solid var(--accent-purple)',
        background: 'color-mix(in srgb, var(--accent-purple) 5%, var(--bg-elev))',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 10px',
            border: '1px solid var(--accent-purple)',
            background: 'color-mix(in srgb, var(--accent-purple) 14%, transparent)',
            borderRadius: 2,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent-purple)',
              display: 'inline-block',
              boxShadow: '0 0 8px var(--accent-purple)',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--accent-purple)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 500,
            }}
          >
            Operator review required
          </span>
        </div>

        <Chip label={`${totals.included}/${contract.totalTests} tests`} />
        <Chip
          label={`L0 ${totals.byLevel.L0} · L1 ${totals.byLevel.L1} · L2 ${totals.byLevel.L2}`}
        />
        <Chip label={`~$${totals.cost.toFixed(3)}`} highlight={totals.cost > 0.1} />
        <Chip label={`~${fmtWallclock(totals.wall)}`} />
        {dirty && <Chip label="edited" muted />}
      </div>

      {/* Warnings */}
      {contract.coverageWarnings.length + contract.specificityWarnings.length > 0 && (
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--warning) 4%, transparent)',
          }}
        >
          <button
            type="button"
            onClick={() => setWarningsOpen((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--warning)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.06em',
            }}
          >
            {warningsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <AlertTriangle size={11} />
            <span>
              {contract.coverageWarnings.length} coverage · {contract.specificityWarnings.length}{' '}
              specificity warning
              {contract.coverageWarnings.length + contract.specificityWarnings.length === 1
                ? ''
                : 's'}
            </span>
          </button>
          {warningsOpen && (
            <ul
              style={{
                listStyle: 'none',
                padding: '8px 0 0 22px',
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                color: 'var(--text-dim)',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.02em',
              }}
            >
              {contract.coverageWarnings.map((w, i) => (
                <li key={`cov-${i}`}>⚠ {w.message}</li>
              ))}
              {contract.specificityWarnings.map((w, i) => (
                <li key={`spec-${i}`}>⚠ {w.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Test table */}
      <div style={{ padding: '14px 18px' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            marginBottom: 10,
          }}
        >
          Tests
        </div>

        {grouped.length === 0 ? (
          <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0 }}>
            No classified tests in this contract.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {grouped.map((group) => (
              <div key={`${group.epicId}-${group.storyId}`}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--text-mute)',
                    letterSpacing: '0.12em',
                    paddingBottom: 6,
                    borderBottom: '1px dashed var(--border)',
                    marginBottom: 6,
                  }}
                >
                  <span style={{ color: 'var(--text-faint)' }}>{group.epicLabel}</span>{' '}
                  <span style={{ color: 'var(--text-dim)' }}>·</span>{' '}
                  <span>{group.storyTitle}</span>
                </div>
                {group.rows.map((row) => (
                  <TestRow
                    key={row.test.testId}
                    row={row}
                    onLevel={(lvl) => setLevel(row.test.testId, lvl)}
                    onInclude={(inc) => setIncluded(row.test.testId, inc)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CTAs */}
      <div
        style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--bg-elev)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          Approving runs qa-execute on the daemon — screenshots arrive in 2–3 min.
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={onReject}
            disabled={reject.isPending || approve.isPending}
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '7px 14px',
              border: '1px solid var(--border-2)',
              borderRadius: 2,
              background: 'transparent',
              color: 'var(--text-dim)',
              cursor: reject.isPending ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              opacity: reject.isPending ? 0.6 : 1,
            }}
          >
            {reject.isPending ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
            Reject — skip QA
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={approve.isPending || reject.isPending || allEmpty}
            title={
              allEmpty
                ? 'No tests selected — include at least one or reject the contract.'
                : `Approve ${totals.included} tests · ~$${totals.cost.toFixed(3)} · ~${fmtWallclock(totals.wall)}`
            }
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '7px 14px',
              border: `1px solid ${allEmpty ? 'var(--border-2)' : 'var(--success)'}`,
              borderRadius: 2,
              background: allEmpty
                ? 'transparent'
                : 'color-mix(in srgb, var(--success) 10%, transparent)',
              color: allEmpty ? 'var(--text-faint)' : 'var(--success)',
              fontWeight: 500,
              cursor: allEmpty || approve.isPending ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              opacity: approve.isPending ? 0.6 : 1,
            }}
          >
            {approve.isPending ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Check size={10} />
            )}
            Approve {totals.included} {totals.included === 1 ? 'test' : 'tests'} · $
            {totals.cost.toFixed(3)} · ~{fmtWallclock(totals.wall)}
          </button>
        </div>
      </div>

      {(approve.error || reject.error) && (
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
            color: 'var(--destructive)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.04em',
          }}
        >
          {(approve.error ?? reject.error) instanceof Error
            ? (approve.error ?? reject.error)!.message
            : 'Request failed — see console.'}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Rejected — compact summary + re-classify CTA
// ────────────────────────────────────────────────────────────────────

function RejectedSummary({ contract, planId }: { contract: QaContractDraft; planId: string }) {
  const reRun = useRunQaReview(planId);
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '12px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
        }}
      >
        QA skipped
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-dim)',
          letterSpacing: '0.04em',
        }}
      >
        Rejected by {contract.decidedBy ?? 'operator'}
        {contract.decidedAt ? ` · ${relTime(contract.decidedAt)}` : ''}
      </span>
      <button
        type="button"
        onClick={() => reRun.mutate()}
        disabled={reRun.isPending}
        style={{
          marginLeft: 'auto',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          padding: '7px 14px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          background: 'transparent',
          color: 'var(--text-dim)',
          cursor: reRun.isPending ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          opacity: reRun.isPending ? 0.6 : 1,
        }}
      >
        {reRun.isPending && <Loader2 size={10} className="animate-spin" />}
        Re-classify
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────

function TestRow({
  row,
  onLevel,
  onInclude,
}: {
  row: DraftRow;
  onLevel: (lvl: VqaTestLevel) => void;
  onInclude: (inc: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto auto auto auto 1fr auto',
        alignItems: 'center',
        gap: 10,
        padding: '6px 4px',
        opacity: row.included ? 1 : 0.45,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-dim)',
        letterSpacing: '0.02em',
      }}
    >
      <input
        type="checkbox"
        checked={row.included}
        onChange={(e) => onInclude(e.target.checked)}
        aria-label={`Include ${row.test.testId}`}
        style={{ cursor: 'pointer' }}
      />
      <span style={{ color: 'var(--text-mute)', fontSize: 9 }}>
        {row.test.testId.replace(/^VT-/, 'VT-').slice(0, 18)}…
      </span>
      <select
        value={row.level}
        onChange={(e) => onLevel(e.target.value as VqaTestLevel)}
        disabled={!row.included}
        aria-label={`Level for ${row.test.testId}`}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          padding: '3px 8px',
          border: `1px solid ${levelBorder(row.level)}`,
          borderRadius: 2,
          background: 'var(--surface)',
          color: levelBorder(row.level),
          letterSpacing: '0.1em',
          cursor: row.included ? 'pointer' : 'not-allowed',
        }}
      >
        <option value="L0">L0</option>
        <option value="L1">L1</option>
        <option value="L2">L2</option>
      </select>
      <span
        style={{
          fontSize: 9,
          color: 'var(--text-faint)',
          letterSpacing: '0.08em',
          padding: '2px 6px',
          border: '1px solid var(--border)',
          borderRadius: 2,
        }}
      >
        {row.test.criteriaRef ?? '—'}
      </span>
      <span
        title={row.test.expect || row.test.description}
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--foreground)',
        }}
      >
        {row.test.expect || row.test.description || '(no expect)'}
      </span>
      <span
        title={row.test.classifierReason}
        style={{ color: 'var(--text-faint)', fontSize: 9, letterSpacing: '0.04em' }}
      >
        ${COST_BY_LEVEL[row.level].toFixed(3)} · {WALLCLOCK_BY_LEVEL[row.level]}s
      </span>
    </div>
  );
}

function Chip({
  label,
  highlight,
  muted,
}: {
  label: string;
  highlight?: boolean;
  muted?: boolean;
}) {
  const color = highlight ? 'var(--warning)' : muted ? 'var(--text-faint)' : 'var(--text-dim)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color,
        letterSpacing: '0.08em',
        padding: '3px 10px',
        border: `1px solid ${highlight ? 'var(--warning)' : 'var(--border-2)'}`,
        borderRadius: 2,
        background: highlight
          ? 'color-mix(in srgb, var(--warning) 8%, transparent)'
          : 'transparent',
      }}
    >
      {label}
    </span>
  );
}

function levelBorder(level: VqaTestLevel): string {
  return level === 'L0'
    ? 'var(--text-mute)'
    : level === 'L1'
      ? 'var(--accent-blue)'
      : 'var(--accent-purple)';
}

function fmtWallclock(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Group {
  epicId: string;
  storyId: string;
  epicLabel: string;
  storyTitle: string;
  rows: DraftRow[];
}

function groupByEpicStory(rows: DraftRow[]): Group[] {
  const order: string[] = [];
  const map = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.test.epicId}::${r.test.storyId}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, {
        epicId: r.test.epicId,
        storyId: r.test.storyId,
        epicLabel: r.test.epicLabel,
        storyTitle: r.test.storyTitle,
        rows: [],
      });
    }
    map.get(key)!.rows.push(r);
  }
  return order.map((k) => map.get(k)!);
}
