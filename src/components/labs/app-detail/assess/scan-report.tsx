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
} from '@/hooks/use-scan-engine';

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

export function ScanReport({ appId, available }: { appId: string; available: boolean }) {
  const { data: report, isLoading } = useScanReport(appId, available);

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
      <PriorityMatrix findings={report.findings} />
      <ByDimension findings={report.findings} />
      <Phases report={report} />
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

function Phases({ report }: { report: ScanReportData }) {
  const byId = useMemo(() => new Map(report.findings.map((f) => [f.id, f])), [report.findings]);
  return (
    <div>
      <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 8px' }}>
        Recommended Sequencing
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {report.phases.map((p) => (
          <div
            key={p.phase}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 10,
              background: 'var(--bg-elev)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 12.5, color: 'var(--foreground)' }}>
                Phase {p.phase} — {p.name}
              </strong>
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
