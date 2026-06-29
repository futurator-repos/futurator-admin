'use client';

/**
 * Refactoring Scan Engine v2 — the report view. Renders the hybrid scan: headline
 * counts, the Severity×Effort priority matrix, findings grouped by dimension, and
 * the phased, dependency-ordered plan (the differentiator). Reads the full scan
 * from S3 via useScanReport; the trigger + status live in the parent assess tab.
 */

import { useMemo, useState } from 'react';
import {
  useScanReport,
  type ScanFinding,
  type ScanReport as ScanReportData,
  type MaturityAxis,
  type InfraInventory,
  type InfraEntry,
} from '@/hooks/use-scan-engine';

/**
 * Infrastructure tab — how the app's infra works: AWS services, databases, AI
 * providers, 3rd-party services, IaC, the front-end↔infra boundary, and (the key
 * cross-link) what data LEAVES to external processors — the precise input the
 * GDPR / EU-AI-Act / data-privacy authorities consume. Deterministic inventory.
 */
function InfraGroup({
  title,
  entries,
  label,
}: {
  title: string;
  entries: InfraEntry[];
  label: (e: InfraEntry) => string;
}) {
  if (!entries.length) return null;
  return (
    <div>
      <div
        style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 4px' }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {entries.map((e, i) => (
          <span
            key={i}
            title={e.files.join('\n')}
            style={{
              fontSize: 11,
              color: 'var(--text-dim)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '3px 9px',
              background: 'var(--background)',
            }}
          >
            <strong style={{ color: 'var(--foreground)' }}>{label(e)}</strong> · {e.fileCount}f
            {e.residency ? (
              <span
                style={{ color: e.residency === 'external' ? 'var(--warning)' : 'var(--text-dim)' }}
              >
                {' '}
                · {e.residency}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function InfraMap({ infra, complianceCount }: { infra: InfraInventory; complianceCount: number }) {
  return (
    <div data-testid="infra-map" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          fontSize: 11.5,
          color: 'var(--text-dim)',
        }}
      >
        <span>{infra.summary.awsServiceCount} AWS services</span>
        <span>{infra.summary.dataStoreCount} data stores</span>
        <span>{infra.summary.aiCount} AI providers</span>
        <span>IaC: {infra.summary.iacProviders.join(', ') || 'none detected'}</span>
        <span>
          boundary: {infra.boundaries.clientFiles} client / {infra.boundaries.serverFiles} server ·{' '}
          {infra.boundaries.externalTouchingFiles} files touch external
        </span>
      </div>

      {/* The cross-link: what data leaves the account → the compliance authorities. */}
      {infra.external.length > 0 && (
        <div
          style={{
            border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
            borderRadius: 10,
            padding: 10,
            background: 'color-mix(in srgb, var(--warning) 6%, transparent)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            ⚠ Data may leave to {infra.external.length} external processor
            {infra.external.length === 1 ? '' : 's'} → feeds GDPR Art. 44 + EU AI Act
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 6px' }}>
            These are the cross-border / 3rd-party transfer surfaces the privacy + AI-Act scans key
            off ({complianceCount} compliance finding{complianceCount === 1 ? '' : 's'} this scan).
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {infra.external.map((e, i) => (
              <span
                key={i}
                style={{
                  fontSize: 11,
                  color: 'var(--foreground)',
                  border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                  borderRadius: 8,
                  padding: '3px 9px',
                }}
              >
                {e.provider}{' '}
                <span style={{ color: 'var(--text-dim)' }}>
                  ({e.kind} · {e.fileCount}f)
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <InfraGroup
        title="AWS services"
        entries={infra.aws}
        label={(e) =>
          `${e.service}${e.category ? ` (${e.category})` : ''}${e.dataStore ? ' · store' : ''}`
        }
      />
      <InfraGroup title="Databases" entries={infra.databases} label={(e) => e.provider || ''} />
      <InfraGroup
        title="AI providers"
        entries={infra.ai}
        label={(e) => `${e.provider}${e.external ? ' · external' : ' · in-account'}`}
      />
      <InfraGroup
        title="3rd-party services"
        entries={infra.thirdParty}
        label={(e) => e.provider || ''}
      />
      <InfraGroup
        title="Infrastructure-as-Code / deploy"
        entries={infra.iac.map((i) => ({
          provider: i.provider,
          fileCount: i.fileCount,
          files: i.files,
        }))}
        label={(e) => e.provider || ''}
      />
      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontStyle: 'italic' }}>
        Static inference from SDK imports + IaC files — service configs (ALB rules, Lambda memory,
        CloudFront behaviours) and live AWS state are not probed.
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  good: 'var(--success, #22c55e)',
  fair: 'var(--warning, #f59e0b)',
  poor: 'var(--destructive, #ef4444)',
  unmeasured: 'var(--text-dim)',
};

/** The high-level codebase maturity overview — a RAG dot per axis (design: the
 *  "checkbox-matrix higher overview"). Filled dots = score/5; unmeasured axes
 *  show a CTA instead of a fake score. */
function MaturityScorecard({ axes, overall }: { axes: MaturityAxis[]; overall: number | null }) {
  const dots = (score: number | null) => {
    if (score == null) return '○○○○○';
    const filled = Math.round(score * 5);
    return '●'.repeat(filled) + '○'.repeat(5 - filled);
  };
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg-elev)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
          Codebase Maturity
        </h4>
        {overall != null && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            overall {Math.round(overall * 100)}%
          </span>
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 6,
        }}
      >
        {axes.map((a) => (
          <div
            key={a.key}
            title={a.detail}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11.5,
              padding: '3px 4px',
            }}
          >
            <span
              style={{
                color: STATUS_COLOR[a.status],
                fontFamily: 'var(--font-mono)',
                letterSpacing: 1,
              }}
            >
              {dots(a.score)}
            </span>
            <span style={{ color: 'var(--foreground)', flex: 1 }}>{a.label}</span>
            <span style={{ color: STATUS_COLOR[a.status], fontSize: 10.5 }}>
              {a.measured ? a.status : '+ add detector'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Download the full v2 scan as a JSON file — for auditing / sharing the scan back
 * for tuning. Self-contained: findings + phases + the generated planOutput + counts.
 */
function downloadScanJson(report: ScanReportData, appId: string) {
  const payload = {
    schema: 'futurator.refactor-scan-v2/v1',
    appId,
    generatedAt: new Date().toISOString(),
    counts: report.counts,
    lowConfidence: report.lowConfidence,
    gateViolations: report.gateViolations,
    phases: report.phases,
    planOutput: report.planOutput ?? null,
    findings: report.findings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scan-v2-${appId}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const SEV_ORDER = ['High', 'Medium', 'Low–Med', 'Low'];
const EFF_ORDER = ['Trivial', 'Small', 'Medium', 'Large'];

/**
 * Compile the SELECTED phases into a dependency-ordered NewPlanModal intent seed —
 * the bridge from assessment to a real, executable refactoring plan. Frames every
 * item as a Strangler-Fig and demands a characterization net before any mutation
 * (the same discipline the deterministic phase-planner already enforces). Capped
 * at 2000 chars (NewPlanModal limit).
 */
export function buildScanPlanIntent(report: ScanReportData, selected: Set<number>): string {
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const phases = report.phases
    .filter((p) => selected.has(p.phase))
    .sort((a, b) => a.phase - b.phase);
  if (!phases.length) return '';
  const head = [
    'Refactor this codebase in the phase order below — foundations before consumers, to minimize rework.',
    'Sequence each item as a Strangler-Fig: extract shared core → repoint dependents → delete the old path,',
    'every deletion/repoint gated on grep-zero + a passing test. Add a characterization test net BEFORE any',
    'deletion/repoint on routes that lack coverage.',
    '',
  ];
  const lines: string[] = [];
  for (const p of phases) {
    lines.push(`## Phase ${p.phase} — ${p.name}  (${p.why})`);
    const items = p.items
      .map((id) => byId.get(id))
      .filter((f): f is ScanFinding => !!f)
      .sort(
        (a, b) =>
          SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
          EFF_ORDER.indexOf(a.effort) - EFF_ORDER.indexOf(b.effort),
      )
      .slice(0, 25);
    for (const f of items)
      lines.push(`- [${f.severity}/${f.effort}] ${f.issue} → ${f.suggestion} (${f.location})`);
    lines.push('');
  }
  const intent = [...head, ...lines].join('\n');
  const CAP = 2000;
  return intent.length <= CAP
    ? intent
    : `${intent.slice(0, CAP - 40).trimEnd()}\n… (truncated; see the full scan)`;
}
const sevColor: Record<string, string> = {
  High: 'var(--destructive, #ef4444)',
  Medium: 'var(--warning, #f59e0b)',
  'Low–Med': 'var(--warning, #f59e0b)',
  Low: 'var(--text-dim)',
};
const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'architecture', label: 'Architecture' },
  { key: 'safety-security', label: 'Safety & Security' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'code-quality-refactoring', label: 'Code Quality / Refactoring' },
  { key: 'correctness', label: 'Correctness' },
];

export function ScanReport({
  appId,
  available,
  onCreatePlan,
}: {
  appId: string;
  available: boolean;
  onCreatePlan?: (intent: string) => void;
}) {
  const { data: report, isLoading } = useScanReport(appId, available);
  const [view, setView] = useState<'report' | 'infra'>('report');

  if (!available) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        No v2 scan yet. Run a scan to generate the dimension-tagged findings + phased plan.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        Loading scan report…
      </div>
    );
  }
  if (!report) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--warning)' }}>
        Scan report not available yet — re-run the scan to regenerate it.
      </div>
    );
  }

  return (
    <div data-testid="scan-report" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Header report={report} appId={appId} />
      {/* Report | Infrastructure sub-tab */}
      <div
        style={{
          display: 'inline-flex',
          alignSelf: 'flex-start',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {(
          [
            ['report', 'Findings & Plan'],
            ['infra', 'Infrastructure'],
          ] as ['report' | 'infra', string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            data-testid={`scan-view-${v}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: view === v ? 'var(--background)' : 'var(--text-dim)',
              background: view === v ? 'var(--foreground)' : 'transparent',
              border: 'none',
              padding: '5px 12px',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'report' ? (
        <>
          {report.maturity?.axes?.length ? (
            <MaturityScorecard axes={report.maturity.axes} overall={report.maturity.overall} />
          ) : null}
          <PriorityMatrix findings={report.findings} />
          <ByDimension findings={report.findings} />
          <Phases report={report} onCreatePlan={onCreatePlan} />
        </>
      ) : report.infra ? (
        <InfraMap
          infra={report.infra}
          complianceCount={report.counts.byDimension?.compliance ?? 0}
        />
      ) : (
        <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
          No infrastructure inventory in this scan — re-scan to generate it.
        </div>
      )}
    </div>
  );
}

function Header({ report, appId }: { report: ScanReportData; appId: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        alignItems: 'center',
        fontSize: 11.5,
        color: 'var(--text-dim)',
      }}
    >
      <strong style={{ color: 'var(--foreground)', fontSize: 13 }}>
        {report.counts.total} findings
      </strong>
      <span>
        {report.counts.deterministic} deterministic · {report.counts.llm} from swarm
      </span>
      <span>{report.phases.length} phases</span>
      {report.gateViolations.length > 0 && (
        <span style={{ color: 'var(--destructive)' }}>
          ⚠ {report.gateViolations.length} characterization-gate violation(s)
        </span>
      )}
      {report.lowConfidence && (
        <span
          style={{ color: 'var(--warning)' }}
          title="Flat/degenerate module structure — subsystem scoping is approximate"
        >
          ⚠ low-confidence decomposition
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={() => downloadScanJson(report, appId)}
        data-testid="scan-export-json"
        title="Download the full scan (findings + phases + plan) as JSON for auditing"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--foreground)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 10px',
          cursor: 'pointer',
        }}
      >
        ⇩ Export JSON
      </button>
    </div>
  );
}

function PriorityMatrix({ findings }: { findings: ScanFinding[] }) {
  const [dim, setDim] = useState<string>('all');
  const rows = useMemo(() => {
    const eff = ['Trivial', 'Small', 'Medium', 'Large'];
    return [...findings]
      .filter((f) => dim === 'all' || f.dimension === dim)
      .sort(
        (a, b) =>
          SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
          eff.indexOf(a.effort) - eff.indexOf(b.effort) ||
          a.area.localeCompare(b.area),
      );
  }, [findings, dim]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
          Priority Matrix
        </h4>
        <select
          value={dim}
          onChange={(e) => setDim(e.target.value)}
          style={{
            fontSize: 11,
            background: 'var(--background)',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '2px 6px',
          }}
        >
          <option value="all">all dimensions</option>
          {DIMENSIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{rows.length} shown</span>
      </div>
      <div
        style={{
          maxHeight: 380,
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-elev)' }}>
              {['Finding', 'Sev', 'Effort', 'Dimension', 'Location'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    color: 'var(--text-dim)',
                    borderBottom: '1px solid var(--border)',
                    fontWeight: 600,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--foreground)' }}>
                  {f.issue}
                  {f.overlaps?.length ? (
                    <span style={{ color: 'var(--text-dim)' }}>
                      {' '}
                      (overlaps {f.overlaps.length})
                    </span>
                  ) : null}
                </td>
                <td
                  style={{
                    padding: '6px 8px',
                    color: sevColor[f.severity],
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {f.severity}
                </td>
                <td style={{ padding: '6px 8px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {f.effort}
                </td>
                <td style={{ padding: '6px 8px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {f.dimension}
                </td>
                <td
                  style={{
                    padding: '6px 8px',
                    color: 'var(--text-dim)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                  }}
                >
                  {f.location}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ByDimension({ findings }: { findings: ScanFinding[] }) {
  const groups = useMemo(() => {
    const m: Record<string, ScanFinding[]> = {};
    for (const f of findings) (m[f.dimension] ||= []).push(f);
    return m;
  }, [findings]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {DIMENSIONS.filter((d) => groups[d.key]?.length).map((d) => (
        <span
          key={d.key}
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            padding: '3px 10px',
          }}
        >
          {d.label}: <strong style={{ color: 'var(--foreground)' }}>{groups[d.key].length}</strong>
        </span>
      ))}
    </div>
  );
}

function Phases({
  report,
  onCreatePlan,
}: {
  report: ScanReportData;
  onCreatePlan?: (intent: string) => void;
}) {
  const byId = useMemo(() => new Map(report.findings.map((f) => [f.id, f])), [report.findings]);
  // Pre-select the two safest early phases (lowest numbers) as a sensible default.
  const [selected, setSelected] = useState<Set<number>>(() => {
    const nums = report.phases.map((p) => p.phase).sort((a, b) => a - b);
    return new Set(nums.slice(0, 2));
  });
  const toggle = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const selectedCount = selected.size;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '0 0 8px',
          flexWrap: 'wrap',
        }}
      >
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
          Recommended Sequencing
        </h4>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          check phases → turn into an executable refactoring plan
        </span>
        <div style={{ flex: 1 }} />
        {onCreatePlan && (
          <button
            type="button"
            onClick={() => onCreatePlan(buildScanPlanIntent(report, selected))}
            disabled={selectedCount === 0}
            data-testid="scan-create-plan"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: selectedCount ? 'var(--accent-blue)' : 'var(--text-dim)',
              background: 'transparent',
              border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: selectedCount ? 'pointer' : 'not-allowed',
              opacity: selectedCount ? 1 : 0.5,
            }}
          >
            Create plan from {selectedCount} phase{selectedCount === 1 ? '' : 's'} →
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {report.phases.map((p) => (
          <div
            key={p.phase}
            style={{
              border: `1px solid ${selected.has(p.phase) ? 'color-mix(in srgb, var(--accent-blue) 50%, var(--border))' : 'var(--border)'}`,
              borderRadius: 8,
              padding: 10,
              background: 'var(--bg-elev)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <label
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.phase)}
                  onChange={() => toggle(p.phase)}
                  data-testid={`scan-phase-check-${p.phase}`}
                />
                <strong style={{ fontSize: 12.5, color: 'var(--foreground)' }}>
                  Phase {p.phase} — {p.name}
                </strong>
              </label>
              <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                {p.tag} · {p.items.length} item{p.items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                margin: '3px 0 6px',
                fontStyle: 'italic',
              }}
            >
              {p.why}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: 'var(--foreground)' }}>
              {p.items.slice(0, 8).map((id) => {
                const f = byId.get(id);
                return (
                  <li key={id} style={{ marginBottom: 2 }}>
                    {f ? f.issue : id}{' '}
                    {f ? <span style={{ color: 'var(--text-dim)' }}>({f.effort})</span> : null}
                  </li>
                );
              })}
              {p.items.length > 8 && (
                <li style={{ color: 'var(--text-dim)' }}>+{p.items.length - 8} more</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
