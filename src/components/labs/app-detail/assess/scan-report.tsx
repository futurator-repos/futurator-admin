'use client';

/**
 * Refactoring Scan Engine v2 — the report view. Renders the hybrid scan: headline
 * counts, the Severity×Effort priority matrix, findings grouped by dimension, and
 * the phased, dependency-ordered plan (the differentiator). Reads the full scan
 * from S3 via useScanReport; the trigger + status live in the parent assess tab.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  useScanReport,
  type ScanFinding,
  type ScanDimension,
  type ScanReport as ScanReportData,
  type MaturityAxis,
  type ReadinessItem,
  type StackProfile,
  type InfraInventory,
  type InfraService,
  type ScanStep,
  type ScanCost,
  type AiReadiness,
  type GitEvolution,
} from '@/hooks/use-scan-engine';

const CONF_COLOR: Record<string, string> = {
  high: 'var(--success, #22c55e)',
  medium: 'var(--warning, #f59e0b)',
  low: 'var(--text-dim)',
};

/**
 * "View on graph" affordance — a small link that jumps to the app-level Graph tab
 * with this module's finding-lens preselected (?tab=graph&lens=<dim>), so the
 * operator sees exactly which file nodes this concern lights up. Dim keys:
 * security|compliance|infra|ai|tests|architecture|code-quality.
 */
function ViewOnGraphLink({ dim }: { dim: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`?tab=graph&lens=${dim}`)}
      data-testid={`scan-view-on-graph-${dim}`}
      title="Highlight the files this concern touches on the code graph"
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--accent-blue, #3b82f6)',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      View on graph →
    </button>
  );
}

/**
 * Infrastructure tab — how the app's infra works, FILE-FIRST + provider-agnostic.
 * Groups services by cloud, marks each declared (IaC/config — authoritative) vs
 * inferred (SDK/env), shows an overall infra signal-quality rating, and (the key
 * cross-link) what data LEAVES to external processors — the precise input the
 * GDPR / EU-AI-Act / data-privacy authorities consume.
 */
function InfraCloudGroup({ cloud, services }: { cloud: string; services: InfraService[] }) {
  if (!services.length) return null;
  return (
    <div>
      <div
        style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 4px' }}
      >
        {cloud}{' '}
        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>({services.length})</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {services.map((s, i) => {
          const declared =
            s.detectedBy.includes('iac-declared') || s.detectedBy.includes('platform-config');
          return (
            <span
              key={i}
              title={`detected by: ${s.detectedBy.join(', ')}${s.declares.length ? `\ndeclares: ${s.declares.join(', ')}` : ''}\n${s.files.join('\n')}`}
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '3px 9px',
                background: 'var(--background)',
              }}
            >
              <strong style={{ color: 'var(--foreground)' }}>{s.name}</strong>
              <span> · {s.kind}</span>
              {s.dataStore ? <span> · store</span> : null}
              <span style={{ color: CONF_COLOR[s.confidence] }}>
                {' '}
                · {declared ? 'declared' : 'inferred'}
              </span>
              {s.residency === 'external' ? (
                <span style={{ color: 'var(--warning)' }}> · external</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const IAC_TIER_LABEL: Record<string, string> = {
  resource: 'resource-declaring IaC',
  migrations: 'schema / migrations',
  orchestration: 'K8s / orchestration',
  'config-mgmt': 'config management',
  container: 'container / image',
  platform: 'platform config',
  ci: 'deploy automation (CI)',
  other: 'config',
};
const GENUINE_IAC_TIER = new Set([
  'resource',
  'migrations',
  'orchestration',
  'config-mgmt',
  'container',
]);
const IAC_TIER_RANK = (t?: string) =>
  ({
    resource: 7,
    migrations: 6,
    orchestration: 5,
    'config-mgmt': 4,
    container: 3,
    platform: 2,
    ci: 1,
    other: 0,
  })[t || 'other'] ?? 0;

const COST_MODEL_META: Record<string, { label: string; note: string; color: string }> = {
  standing: {
    label: 'Standing',
    note: 'bills even idle (RDS, Fargate, NAT, ALB, EC2)',
    color: 'var(--destructive, #ef4444)',
  },
  metered: {
    label: 'Metered',
    note: 'pay-per-use (S3, DynamoDB, Lambda, SES, tokens)',
    color: 'var(--warning, #f59e0b)',
  },
  subscription: {
    label: 'Subscription',
    note: 'SaaS tier (Vercel, Supabase, Auth0)',
    color: 'var(--accent-blue, #3b82f6)',
  },
  connectivity: {
    label: '3rd-party API',
    note: 'you call it, they meter it (OpenAI, Anthropic, Stripe)',
    color: 'var(--warning, #f59e0b)',
  },
};

/** Cost surface — every detected service is a billable RELATIONSHIP ($0 until used).
 *  The FinOps "Inform" view: enumerate cost sources by model so they're visible
 *  before the first invoice. Dollars are NOT computed (live rates not probed). */
function CostSurfacePanel({ infra }: { infra: InfraInventory }) {
  const groups = useMemo(() => {
    const m: Record<string, InfraService[]> = {};
    for (const s of infra.services) {
      const cm = s.costModel || 'unknown';
      if (cm === 'none' || cm === 'unknown') continue;
      (m[cm] ||= []).push(s);
    }
    return m;
  }, [infra.services]);
  const order = ['standing', 'metered', 'subscription', 'connectivity'].filter(
    (k) => groups[k]?.length,
  );
  if (!order.length) return null;
  return (
    <div
      data-testid="cost-surface"
      style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
        Potential cost sources{' '}
        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
          — billable relationships ($0 until used; live rates not probed)
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {order.map((cm) => {
          const meta = COST_MODEL_META[cm];
          return (
            <div key={cm}>
              <div style={{ fontSize: 11, color: meta.color, fontWeight: 600 }}>
                {meta.label}{' '}
                <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {meta.note}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
                {groups[cm].map((s, i) => (
                  <span
                    key={i}
                    title={`${s.kind}${s.cloud ? ` · ${s.cloud}` : ''} · detected by ${s.detectedBy.join(', ')}`}
                    style={{
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '2px 8px',
                    }}
                  >
                    <strong style={{ color: 'var(--foreground)' }}>{s.name}</strong>
                    {s.cloud && s.cloud !== '3rd-party' ? <span> · {s.cloud}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfraMap({ infra, complianceCount }: { infra: InfraInventory; complianceCount: number }) {
  const byCloud = useMemo(() => {
    const m: Record<string, InfraService[]> = {};
    for (const s of infra.services) (m[s.cloud] ||= []).push(s);
    return m;
  }, [infra.services]);
  const cloudOrder = Object.keys(byCloud).sort((a, b) => byCloud[b].length - byCloud[a].length);
  const sig = infra.signalQuality;
  const cov = infra.iacCoverage || infra.summary.iacCoverage;
  const sigColor =
    sig.level === 'high'
      ? 'var(--success, #22c55e)'
      : sig.level === 'medium'
        ? 'var(--warning, #f59e0b)'
        : 'var(--destructive, #ef4444)';

  return (
    <div data-testid="infra-map" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Signal-quality banner — how well this codebase EXPRESSES its infra. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
          border: `1px solid ${sigColor}`,
          borderRadius: 8,
          padding: '6px 10px',
        }}
      >
        <strong style={{ color: sigColor }}>Infra signal: {sig.level.toUpperCase()}</strong>
        <span style={{ color: 'var(--text-dim)' }}>{sig.detail}</span>
      </div>

      {/* IaC coverage — of the cloud resources this app provisions, how many are
          declared in code? (cost-center precondition + agent-tractability). */}
      {cov && cov.provisionable > 0 && (
        <div
          data-testid="iac-coverage"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11.5,
            border: `1px solid ${cov.ratio === 1 ? 'color-mix(in srgb, var(--success) 45%, var(--border))' : 'color-mix(in srgb, var(--warning) 45%, var(--border))'}`,
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          <strong
            style={{
              color: cov.ratio === 1 ? 'var(--success, #22c55e)' : 'var(--warning, #f59e0b)',
            }}
          >
            Infra-as-code: {cov.declared}/{cov.provisionable} declared
          </strong>
          <span style={{ color: 'var(--text-dim)' }}>
            {cov.ratio === 1
              ? 'every cloud resource is declared in code'
              : `${cov.provisionable - cov.declared} used but not declared in this repo (${cov.undeclared.slice(0, 4).join(', ')}${cov.undeclared.length > 4 ? '…' : ''}) — click-ops risk, or declared in a sibling infra repo`}
          </span>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          fontSize: 11.5,
          color: 'var(--text-dim)',
        }}
      >
        <span>clouds: {infra.clouds.join(', ') || 'none'}</span>
        <span>{infra.summary.serviceCount} services</span>
        <span>{infra.summary.dataStoreCount} data stores</span>
        <span>IaC: {infra.summary.iacProviders.join(', ') || 'none declared'}</span>
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

      <CostSurfacePanel infra={infra} />

      {cloudOrder.map((cloud) => (
        <InfraCloudGroup key={cloud} cloud={cloud} services={byCloud[cloud]} />
      ))}

      {infra.iac.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--foreground)',
              margin: '0 0 4px',
            }}
          >
            IaC / config files (declared)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[...infra.iac]
              .sort((a, b) => IAC_TIER_RANK(b.tier) - IAC_TIER_RANK(a.tier))
              .map((i, idx) => (
                <span
                  key={idx}
                  title={`${i.file}${i.tier ? ` · ${IAC_TIER_LABEL[i.tier] || i.tier}` : ''}`}
                  style={{
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    border: `1px solid ${GENUINE_IAC_TIER.has(i.tier || '') ? 'color-mix(in srgb, var(--success) 40%, var(--border))' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: '3px 9px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {i.provider}
                  {i.tier === 'ci' ? <span style={{ color: 'var(--text-dim)' }}> · ci</span> : null}
                </span>
              ))}
          </div>
        </div>
      )}

      {infra.deployScripts && infra.deployScripts.length > 0 && (
        <div
          style={{
            border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
            borderRadius: 10,
            padding: 10,
            background: 'color-mix(in srgb, var(--warning) 6%, transparent)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            ⚠ {infra.deployScripts.length} hand-rolled deploy artifact
            {infra.deployScripts.length === 1 ? '' : 's'} (not IaC)
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 6px' }}>
            Resources provisioned by shell scripts / inline IAM policies — outside code review +
            drift detection. This is why cloud resources can read “used but not declared”.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {infra.deployScripts.map((d, i) => (
              <span
                key={i}
                title={d.file}
                style={{
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                  borderRadius: 8,
                  padding: '3px 9px',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {d.file.split('/').pop()}
                <span style={{ color: 'var(--foreground)' }}>
                  {' '}
                  · {d.kind === 'iam-policy' ? 'IAM policy' : 'deploy script'}
                </span>
                {d.provisions?.length ? <span> · {d.provisions.join(', ')}</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontStyle: 'italic' }}>
        File-first: IaC/config files are read as authoritative (declared); SDK imports + env keys
        are inferred. Service-level configs (ALB rules, Lambda memory, …) and live cloud state are
        not probed.
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

/** RAG dots for a 0–1 quality score (filled = score/5; null → all empty). */
function maturityDots(score: number | null): string {
  if (score == null) return '○○○○○';
  const filled = Math.round(score * 5);
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

/** The high-level QUALITY overview — a RAG dot per axis (design: the
 *  "checkbox-matrix higher overview"). Filled dots = score/5; unmeasured axes
 *  show a CTA instead of a fake score. Binary readiness lives separately. */
function MaturityScorecard({ axes, overall }: { axes: MaturityAxis[]; overall: number | null }) {
  const dots = maturityDots;
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
          Quality
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
 * Stack Profile header — the deterministic tech-profile of the scanned repo (the
 * "what is this?" line): a one-line summary + chips for the detected frameworks,
 * UI libs, and databases. Purely informational; feeds no scoring.
 */
function StackProfileHeader({ stack }: { stack: StackProfile }) {
  const chips: { text: string; group: string }[] = [
    ...stack.frameworks.map((f) => ({ text: f, group: 'framework' })),
    ...stack.ui.map((u) => ({ text: u, group: 'ui' })),
    ...stack.databases.map((d) => ({ text: d, group: 'db' })),
  ];
  return (
    <div
      data-testid="scan-stack-profile"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: chips.length ? 8 : 0,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)' }}>
        {stack.summary || 'Stack profile'}
      </div>
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((c, i) => (
            <span
              key={`${c.group}-${c.text}-${i}`}
              title={c.group}
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '2px 9px',
                background: 'var(--background)',
              }}
            >
              <strong style={{ color: 'var(--foreground)' }}>{c.text}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Readiness checklist — BINARY present/absent checks (graph built? IaC? tests?
 * lockfile? …), kept SEPARATE from the quality RAG scorecard. A compact row of
 * ✓/✗ items so "is this codebase set up for agentic work?" reads at a glance.
 */
function ReadinessChecklist({ items }: { items: ReadinessItem[] }) {
  if (!items.length) return null;
  return (
    <div
      data-testid="scan-readiness"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg-elev)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', marginBottom: 8 }}>
        Readiness
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((it) => (
          <span
            key={it.key}
            title={it.detail}
            data-testid={`scan-readiness-${it.key}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: 'var(--text-dim)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '3px 10px',
            }}
          >
            <span
              style={{
                color: it.present ? 'var(--success, #22c55e)' : 'var(--destructive, #ef4444)',
                fontWeight: 700,
              }}
            >
              {it.present ? '✓' : '✗'}
            </span>
            <span style={{ color: 'var(--foreground)' }}>{it.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Human ms formatter — sub-second → "845ms", else "1.2s" / "1m03s". */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
/** Compact token count — 12300 → "12.3k". */
function fmtTokens(t: number | null): string {
  if (t == null) return '—';
  if (t < 1000) return String(t);
  return `${(t / 1000).toFixed(1)}k`;
}
/** Dollars with cents (or sub-cent) — 0.0042 → "$0.004". */
function fmtUsd(u: number | null): string {
  if (u == null) return '—';
  if (u === 0) return '$0';
  return u < 0.01 ? `$${u.toFixed(4)}` : `$${u.toFixed(2)}`;
}
const STEP_KIND_COLOR: Record<string, string> = {
  recon: 'var(--text-dim)',
  analyzer: 'var(--accent-blue, #3b82f6)',
  pass: 'var(--warning, #f59e0b)',
  report: 'var(--success, #22c55e)',
  other: 'var(--text-dim)',
};

/**
 * Timeline & cost — the scan's execution ledger (C-LEDGER). Steps sorted
 * slowest-first so the heavy contributors are obvious, each with duration +
 * tokens + $; topped by the rolled-up totals and a per-kind breakdown. Makes the
 * scan auditable (why it took as long / cost as much as it did).
 */
function TimelineCostPanel({ timeline, cost }: { timeline?: ScanStep[]; cost?: ScanCost }) {
  const steps = useMemo(
    () => [...(timeline ?? [])].sort((a, b) => b.durationMs - a.durationMs),
    [timeline],
  );
  if (!steps.length && !cost) return null;
  const kindOrder = cost
    ? Object.keys(cost.byKind).sort((a, b) => cost.byKind[b].ms - cost.byKind[a].ms)
    : [];
  return (
    <div
      data-testid="scan-timeline"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg-elev)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
          Timeline &amp; cost
        </h4>
        {cost && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {fmtTokens(cost.totalTokens)} tokens · {fmtUsd(cost.totalUsd)} · {steps.length} step
            {steps.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {kindOrder.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {kindOrder.map((k) => (
            <span
              key={k}
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '2px 9px',
              }}
            >
              <strong style={{ color: STEP_KIND_COLOR[k] || 'var(--foreground)' }}>{k}</strong> ·{' '}
              {fmtMs(cost!.byKind[k].ms)} · {fmtTokens(cost!.byKind[k].tokens)} ·{' '}
              {fmtUsd(cost!.byKind[k].usd)}
            </span>
          ))}
        </div>
      )}

      {steps.length > 0 && (
        <div
          style={{
            maxHeight: 360,
            overflow: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-elev)' }}>
                {['Step', 'Kind', 'Duration', 'Tokens', 'Cost'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: h === 'Step' || h === 'Kind' ? 'left' : 'right',
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
              {steps.map((s, i) => (
                <tr key={`${s.step}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px', color: 'var(--foreground)' }}>{s.label}</td>
                  <td
                    style={{
                      padding: '6px 8px',
                      color: STEP_KIND_COLOR[s.kind] || 'var(--text-dim)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.kind}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      color: 'var(--foreground)',
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtMs(s.durationMs)}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      color: 'var(--text-dim)',
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {fmtTokens(s.tokens)}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      color: 'var(--text-dim)',
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {fmtUsd(s.costUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * AI module tab — the repo's AI-readiness profile (C-AI): the summary line, a
 * present/absent chip per detected tool, the skill/agent/command/MCP counts, and
 * any AI-readiness findings via the shared PriorityMatrix.
 */
function AiReadinessTab({ ai, findings }: { ai?: AiReadiness; findings: ScanFinding[] }) {
  const aiFindings = useMemo(
    () =>
      findings.filter(
        (f) =>
          f.producedBy === 'ai-readiness' || /ai-readiness|agentic|claude[- ]?code/i.test(f.area),
      ),
    [findings],
  );
  if (!ai) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        No AI-readiness profile in this scan — re-scan to generate it.
      </div>
    );
  }
  const counts: { label: string; value: number }[] = [
    { label: 'skills', value: ai.skillCount },
    { label: 'agents', value: ai.agentCount },
    { label: 'commands', value: ai.commandCount },
    { label: 'MCP', value: ai.hasMcp ? 1 : 0 },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 12,
          background: 'var(--bg-elev)',
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)' }}>
          {ai.summary || 'AI readiness'}
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
            marginTop: 8,
            fontSize: 11.5,
            color: 'var(--text-dim)',
          }}
        >
          {counts.map((c) => (
            <span key={c.label}>
              <strong style={{ color: 'var(--foreground)' }}>{c.value}</strong> {c.label}
            </span>
          ))}
          <span>
            Claude Code:{' '}
            <strong
              style={{ color: ai.hasClaudeCode ? 'var(--success, #22c55e)' : 'var(--text-dim)' }}
            >
              {ai.hasClaudeCode ? 'yes' : 'no'}
            </strong>
          </span>
          <span>
            hooks:{' '}
            <strong style={{ color: ai.hasHooks ? 'var(--success, #22c55e)' : 'var(--text-dim)' }}>
              {ai.hasHooks ? 'yes' : 'no'}
            </strong>
          </span>
        </div>
      </div>

      {ai.tools.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {ai.tools.map((t, i) => (
            <span
              key={`${t.name}-${i}`}
              title={`${t.detail}${t.files.length ? `\n${t.files.join('\n')}` : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: 'var(--text-dim)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '3px 10px',
                background: 'var(--background)',
              }}
            >
              <span
                style={{
                  color: t.present ? 'var(--success, #22c55e)' : 'var(--destructive, #ef4444)',
                  fontWeight: 700,
                }}
              >
                {t.present ? '✓' : '✗'}
              </span>
              <span style={{ color: 'var(--foreground)' }}>{t.name}</span>
            </span>
          ))}
        </div>
      )}

      {aiFindings.length ? (
        <PriorityMatrix findings={aiFindings} />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '4px 0' }}>
          No AI-readiness findings in this scan.
        </div>
      )}
    </div>
  );
}

/**
 * Git & Evolution tab (C-GIT) — the deterministic parse of the repo's git history
 * (the TIME axis the import graph can't see): branch/commit hygiene, churn
 * hotspots, temporal coupling (co-change pairs), and bus-factor. Author emails are
 * never surfaced (names/counts only). Guards when no git analysis ran; degrades on
 * a shallow clone.
 */
function GitTab({ git }: { git?: GitEvolution }) {
  if (!git) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        No git analysis in this scan — re-scan to generate it.
      </div>
    );
  }
  const hotFiles = git.hotFiles ?? [];
  const coupling = git.temporalCoupling ?? [];
  const topAuthors = git.busFactor?.topAuthors ?? [];
  const churnMax = hotFiles.length ? hotFiles[0].churn || 1 : 1;
  const chipStyle = {
    fontSize: 11,
    color: 'var(--text-dim)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '3px 9px',
    fontFamily: 'var(--font-mono)' as const,
  };

  return (
    <div
      data-testid="scan-module-git"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {/* Header card — summary + the "measured by" caption. */}
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 12,
          background: 'var(--bg-elev)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', flex: 1 }}>
            {git.summary || 'Git & evolution'}
          </div>
          {git.shallow ? (
            <span
              title="Shallow clone — churn / coupling / bus-factor are limited"
              style={{ fontSize: 10.5, color: 'var(--warning, #f59e0b)', fontWeight: 600 }}
            >
              ⚠ shallow clone
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 6 }}>
          Measured by:{' '}
          <strong style={{ color: 'var(--foreground)', fontWeight: 600 }}>git history</strong>
        </div>
        {git.isRepo ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 14,
              marginTop: 8,
              fontSize: 11.5,
              color: 'var(--text-dim)',
            }}
          >
            <span>
              branches: <strong style={{ color: 'var(--foreground)' }}>{git.branches.total}</strong>
              {git.branches.stale > 0 ? (
                <span style={{ color: 'var(--warning, #f59e0b)' }}>
                  {' '}
                  · {git.branches.stale} stale
                </span>
              ) : null}
              {git.branches.current ? <span> · on {git.branches.current}</span> : null}
            </span>
            <span>
              commits: <strong style={{ color: 'var(--foreground)' }}>{git.commits.total}</strong> ·{' '}
              {git.commits.last30d} in 30d · {git.commits.conventionalPct}% conventional · ~
              {git.commits.avgSizeFiles} files/commit
            </span>
            <span>
              tags: <strong style={{ color: 'var(--foreground)' }}>{git.tags}</strong>
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 8 }}>
            Not a git repository — no history / provenance signal.
          </div>
        )}
      </div>

      {/* Churn hotspots — files by change frequency (churn = commit count). */}
      {hotFiles.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--foreground)',
              margin: '0 0 4px',
            }}
          >
            Churn hotspots{' '}
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              (top {hotFiles.length} by change frequency)
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {hotFiles.map((h, i) => (
              <span
                key={`${h.file}-${i}`}
                title={h.file}
                style={{
                  ...chipStyle,
                  color: 'var(--foreground)',
                  borderColor:
                    h.churn >= churnMax * 0.66
                      ? 'color-mix(in srgb, var(--warning) 45%, var(--border))'
                      : 'var(--border)',
                }}
              >
                {shortPath(h.file)}
                <span style={{ color: 'var(--text-dim)' }}> · {h.churn}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Temporal coupling — files that co-change (the import graph can't see this). */}
      {coupling.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--foreground)',
              margin: '0 0 4px',
            }}
          >
            Temporal coupling{' '}
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              (top co-change pairs — hidden dependencies)
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {coupling.map((c, i) => (
              <div
                key={`${c.a}-${c.b}-${i}`}
                style={{
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <span style={{ color: 'var(--foreground)' }}>{shortPath(c.a)}</span>
                {' ⇄ '}
                <span style={{ color: 'var(--foreground)' }}>{shortPath(c.b)}</span>{' '}
                <span>
                  · {c.together}× · {Math.round(c.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bus factor — knowledge concentration (names/counts only; no emails). */}
      {git.busFactor && (
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--foreground)',
              margin: '0 0 4px',
            }}
          >
            Bus factor{' '}
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              ({git.busFactor.singleAuthorFiles} single-author file
              {git.busFactor.singleAuthorFiles === 1 ? '' : 's'})
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {topAuthors.map((a, i) => (
              <span key={`${a.name}-${i}`} style={{ ...chipStyle, fontFamily: 'inherit' }}>
                <strong style={{ color: 'var(--foreground)' }}>{a.name}</strong>
                <span> · {a.pct}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {git.findings?.length ? (
        <PriorityMatrix findings={git.findings} />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '4px 0' }}>
          No git-evolution findings in this scan.
        </div>
      )}
    </div>
  );
}

/** Per-module tab config: which finding dimension + quality-axis module it maps
 *  to, and which deterministic/LLM authority MEASURES it (the caption). */
type ModuleTabConfig = {
  module: string;
  /** dimension to filter findings by (undefined → use the custom finding filter). */
  dimension?: ScanDimension;
  authority: string;
  label: string;
  /** graph finding-lens key for the "View on graph" deep-link. */
  lens: string;
};
const MODULE_TABS: Record<string, ModuleTabConfig> = {
  security: {
    module: 'security',
    dimension: 'safety-security',
    authority: 'deterministic security scan + swarm safety pass',
    label: 'Security',
    lens: 'security',
  },
  compliance: {
    module: 'compliance',
    dimension: 'compliance',
    authority: 'GDPR / EU-AI-Act privacy scan (data-leaving-the-account)',
    label: 'Compliance',
    lens: 'compliance',
  },
  architecture: {
    module: 'architecture',
    dimension: 'architecture',
    authority: 'graph decomposition + structure recon',
    label: 'Architecture',
    lens: 'architecture',
  },
  'code-quality': {
    module: 'code-quality',
    dimension: 'code-quality-refactoring',
    authority: 'ESLint + type-safety + refactoring swarm',
    label: 'Code quality',
    lens: 'code-quality',
  },
  testing: {
    module: 'testing',
    authority: 'TDD-maturity detector',
    label: 'Testing',
    lens: 'tests',
  },
};

/** The scan sub-tabs (view switcher). Overview + Infrastructure + one per module + Plan. */
type ScanView =
  | 'overview'
  | 'infra'
  | 'security'
  | 'compliance'
  | 'architecture'
  | 'code-quality'
  | 'testing'
  | 'ai'
  | 'git'
  | 'plan';
const SCAN_TABS: [ScanView, string][] = [
  ['overview', 'Overview'],
  ['infra', 'Infrastructure'],
  ['security', 'Security'],
  ['compliance', 'Compliance'],
  ['architecture', 'Architecture'],
  ['code-quality', 'Code quality'],
  ['testing', 'Testing'],
  ['ai', 'AI'],
  ['git', 'Git'],
  ['plan', 'Plan'],
];

/**
 * A module tab — one dimension's findings via the existing PriorityMatrix table,
 * captioned with what MEASURED it plus that module's quality RAG dot(s) pulled
 * from the maturity scorecard (axes tagged with the same `module`).
 */
function ModuleTab({ report, cfg }: { report: ScanReportData; cfg: ModuleTabConfig }) {
  const findings = useMemo(() => {
    if (cfg.dimension) return report.findings.filter((f) => f.dimension === cfg.dimension);
    // Testing has no dedicated dimension — key off the finding area/issue.
    return report.findings.filter(
      (f) => /test|spec|coverage|tdd/i.test(f.area) || /\btest(s|ing)?\b|coverage/i.test(f.issue),
    );
  }, [report.findings, cfg]);
  const axes = useMemo(
    () => (report.maturity?.axes ?? []).filter((a) => a.module === cfg.module),
    [report.maturity, cfg.module],
  );

  return (
    <div
      data-testid={`scan-module-${cfg.module}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          fontSize: 11,
          color: 'var(--text-dim)',
        }}
      >
        <span>
          Measured by:{' '}
          <strong style={{ color: 'var(--foreground)', fontWeight: 600 }}>{cfg.authority}</strong>
        </span>
        <div style={{ flex: 1 }} />
        {axes.map((a) => (
          <span
            key={a.key}
            title={a.detail}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                color: STATUS_COLOR[a.status],
                fontFamily: 'var(--font-mono)',
                letterSpacing: 1,
              }}
            >
              {maturityDots(a.score)}
            </span>
            <span style={{ color: 'var(--foreground)' }}>{a.label}</span>
          </span>
        ))}
        <ViewOnGraphLink dim={cfg.lens} />
      </div>
      {findings.length ? (
        <PriorityMatrix findings={findings} />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '8px 0' }}>
          No {cfg.label.toLowerCase()} findings in this scan.
        </div>
      )}
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
    scannedSha: report.scannedSha ?? null,
    scannedAt: report.scannedAt ?? null,
    mode: report.mode ?? null,
    stack: report.stack ?? null,
    counts: report.counts,
    lowConfidence: report.lowConfidence,
    maturity: report.maturity ?? null,
    infra: report.infra ?? null,
    aiReadiness: report.aiReadiness ?? null,
    gitEvolution: report.gitEvolution ?? null,
    gateViolations: report.gateViolations,
    phases: report.phases,
    planOutput: report.planOutput ?? null,
    timeline: report.timeline ?? null,
    cost: report.cost ?? null,
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

/** Re-scan request shape — handled by the parent (POSTs scan-engine + tracks the job). */
export type RescanInput = { targets?: string[]; reuseRecon?: boolean; autoTargetChanged?: boolean };

/** The 5 cross-cutting passes (stable `producedBy` keys), with display labels. */
const CROSS_CUTTING_PASSES: { area: string; label: string }[] = [
  { area: 'error-handling', label: 'Error handling' },
  { area: 'magic-numbers', label: 'Magic numbers' },
  { area: 'type-safety', label: 'Type safety' },
  { area: 'ui-centralization', label: 'UI centralization' },
  { area: 'safety-security', label: 'Safety & security' },
];

const subsystemLabel = (key: string) => key.replace(/^§sys:/, '').replace(/--/g, '/');

/**
 * Granular re-scan panel — re-run only PART of the swarm and merge into the
 * persisted scan. Cross-cutting passes + analyzed subsystems are listed with their
 * current finding counts (grouped by `producedBy`); each selected task is ~1 agent
 * (vs ~48 for a full scan). A re-run that returns zero findings for a task removes
 * its old findings (= "confirm I fixed these"). Also offers a one-click
 * "Re-scan changed files" when the scan recorded the SHA it ran against.
 */
function RerunParts({
  report,
  onRescan,
  scanRunning,
}: {
  report: ScanReportData;
  onRescan: (input: RescanInput) => void;
  scanRunning?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reuseRecon, setReuseRecon] = useState(true);
  const [showAllSubsystems, setShowAllSubsystems] = useState(false);

  // Group findings by their producing task (the merge key).
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of report.findings) if (f.producedBy) m[f.producedBy] = (m[f.producedBy] || 0) + 1;
    return m;
  }, [report.findings]);

  const subsystems = useMemo(
    () =>
      Object.keys(counts)
        .filter((k) => k.startsWith('§sys:'))
        .sort((a, b) => counts[b] - counts[a]),
    [counts],
  );
  const attributable = useMemo(
    () => report.findings.filter((f) => f.producedBy && f.producedBy !== 'deterministic').length,
    [report.findings],
  );

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Older scans (pre-producedBy) can't be sliced; a full re-scan re-stamps them.
  if (!attributable) {
    return (
      <details data-testid="scan-rerun-parts">
        <summary style={{ fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer' }}>
          Re-run parts
        </summary>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '8px 0' }}>
          This scan predates per-task tagging — run one full <strong>Re-scan</strong> to enable
          granular re-runs.
        </div>
      </details>
    );
  }

  const selectedList = [...selected];
  const visibleSubsystems = showAllSubsystems ? subsystems : subsystems.slice(0, 8);

  const chip = (key: string, label: string, count: number) => {
    const on = selected.has(key);
    return (
      <label
        key={key}
        title={key}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          border: `1px solid ${on ? 'color-mix(in srgb, var(--accent-blue) 55%, var(--border))' : 'var(--border)'}`,
          borderRadius: 8,
          padding: '3px 9px',
          cursor: scanRunning ? 'not-allowed' : 'pointer',
          background: on
            ? 'color-mix(in srgb, var(--accent-blue) 10%, transparent)'
            : 'var(--background)',
        }}
      >
        <input
          type="checkbox"
          checked={on}
          disabled={scanRunning}
          onChange={() => toggle(key)}
          data-testid={`scan-rerun-task-${key}`}
        />
        <span style={{ color: 'var(--foreground)' }}>{label}</span>
        <span style={{ color: 'var(--text-dim)' }}>({count})</span>
      </label>
    );
  };

  return (
    <details data-testid="scan-rerun-parts">
      <summary
        style={{ fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', userSelect: 'none' }}
      >
        Re-run parts{' '}
        <span style={{ color: 'var(--text-dim)' }}>
          — re-scan selected subsystems / passes (~1 agent each)
        </span>
      </summary>
      <div
        style={{
          marginTop: 8,
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: 'var(--bg-elev)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            selected: <strong style={{ color: 'var(--foreground)' }}>{selectedList.length}</strong>{' '}
            task{selectedList.length === 1 ? '' : 's'} (~{selectedList.length} agent
            {selectedList.length === 1 ? '' : 's'})
          </span>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-dim)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={reuseRecon}
              disabled={scanRunning}
              onChange={(e) => setReuseRecon(e.target.checked)}
              data-testid="scan-rerun-reuse-recon"
            />
            reuse recon (faster; untick after a code change)
          </label>
          <div style={{ flex: 1 }} />
          {report.scannedSha && (
            <button
              type="button"
              onClick={() => onRescan({ autoTargetChanged: true })}
              disabled={scanRunning}
              data-testid="scan-rerun-changed"
              title={`Diff the clone against the last-scanned commit (${report.scannedSha.slice(0, 7)}) and re-scan only the subsystems whose files changed`}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--foreground)',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '5px 10px',
                cursor: scanRunning ? 'not-allowed' : 'pointer',
                opacity: scanRunning ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              ↻ Re-scan changed files
            </button>
          )}
          <button
            type="button"
            onClick={() => onRescan({ targets: selectedList, reuseRecon })}
            disabled={scanRunning || selectedList.length === 0}
            data-testid="scan-rerun-selected"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: selectedList.length ? 'var(--background)' : 'var(--text-dim)',
              background: selectedList.length ? 'var(--foreground)' : 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: scanRunning || !selectedList.length ? 'not-allowed' : 'pointer',
              opacity: scanRunning || !selectedList.length ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            ↻ Re-run selected
          </button>
        </div>

        <div>
          <div
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 5px' }}
          >
            Cross-cutting passes
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CROSS_CUTTING_PASSES.filter((pass) => counts[pass.area]).map((pass) =>
              chip(pass.area, pass.label, counts[pass.area]),
            )}
          </div>
        </div>

        {subsystems.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--foreground)',
                margin: '0 0 5px',
              }}
            >
              Subsystems{' '}
              <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
                (by current finding count)
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {visibleSubsystems.map((key) => chip(key, subsystemLabel(key), counts[key]))}
              {subsystems.length > 8 && (
                <button
                  type="button"
                  onClick={() => setShowAllSubsystems((v) => !v)}
                  style={{
                    fontSize: 11,
                    color: 'var(--accent-blue)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {showAllSubsystems ? 'show fewer' : `+${subsystems.length - 8} more`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

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
/** Last two path segments — disambiguates same-basename files (many route.ts). */
export function shortPath(p: string): string {
  const parts = String(p || '')
    .split('/')
    .filter(Boolean);
  return parts.length <= 1 ? String(p || '') : parts.slice(-2).join('/');
}

const DIM_LABEL: Record<string, string> = {
  'safety-security': 'Safety & security',
  compliance: 'Compliance',
  architecture: 'Architecture',
  'code-quality-refactoring': 'Code quality / refactoring',
  correctness: 'Correctness',
};
const DIM_ORDER = [
  'safety-security',
  'compliance',
  'architecture',
  'code-quality-refactoring',
  'correctness',
];

/**
 * Compile the full scan into a shareable Markdown report for the codebase's own agent:
 * exec summary + problems grouped by dimension & sorted by severity + infra/git highlights
 * + the selected-phase refactoring plan. Every problem carries file:line + a suggested fix
 * so an agent can act directly.
 */
export function buildMarkdownReport(
  report: ScanReportData,
  appId: string,
  selectedPhases: Set<number>,
): string {
  const L: string[] = [];
  const sha = report.scannedSha ? ` · commit \`${report.scannedSha.slice(0, 7)}\`` : '';
  L.push(`# ${appId} — Code Quality & Refactoring Report`);
  L.push('');
  L.push(`> Generated ${new Date().toISOString()} · Refactoring Scan v2 (hybrid), report-only.`);
  if (report.stack?.summary) L.push(`> **Stack:** ${report.stack.summary}`);
  L.push(
    `> **${report.counts.total} findings** (${report.counts.deterministic} deterministic + ${report.counts.llm} swarm) · ${report.phases.length} phases${sha}`,
  );
  L.push('');

  // Executive summary
  L.push('## Executive summary');
  if (report.maturity?.overall != null)
    L.push(`- **Maturity: ${Math.round(report.maturity.overall * 100)}%** overall`);
  if (report.maturity?.readiness?.length) {
    L.push(
      `- **Readiness:** ${report.maturity.readiness.map((r) => `${r.present ? '✓' : '✗'} ${r.label}`).join(' · ')}`,
    );
  }
  for (const a of report.maturity?.axes ?? []) {
    if (a.measured) L.push(`- ${a.label}: **${a.status}** — ${a.detail}`);
  }
  L.push('');

  // Problems grouped by dimension, sorted by severity then effort
  L.push('## Problems by area');
  L.push('');
  const byDim: Record<string, ScanFinding[]> = {};
  for (const f of report.findings) (byDim[f.dimension] ||= []).push(f);
  const CAP = 50;
  for (const dim of DIM_ORDER) {
    const group = byDim[dim];
    if (!group?.length) continue;
    group.sort(
      (a, b) =>
        SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
        EFF_ORDER.indexOf(a.effort) - EFF_ORDER.indexOf(b.effort),
    );
    L.push(`### ${DIM_LABEL[dim] || dim} (${group.length})`);
    for (const f of group.slice(0, CAP)) {
      L.push(
        `- **${f.severity}** · ${f.effort} — ${f.issue} — \`${f.location}\`${f.suggestion ? ` → ${f.suggestion}` : ''}`,
      );
    }
    if (group.length > CAP) L.push(`- _…+${group.length - CAP} more (see the full scan)_`);
    L.push('');
  }

  // Infrastructure
  const infra = report.infra;
  if (infra) {
    L.push('## Infrastructure');
    L.push(
      `- Clouds: ${infra.clouds.join(', ') || 'none'} · ${infra.summary.serviceCount} services · IaC: ${infra.summary.iacProviders.join(', ') || 'none declared'}`,
    );
    const cov = infra.iacCoverage || infra.summary.iacCoverage;
    if (cov && cov.provisionable > 0) {
      L.push(
        `- IaC coverage: ${cov.declared}/${cov.provisionable} own-cloud resources declared${cov.undeclared.length ? ` — used-but-undeclared: ${cov.undeclared.join(', ')}` : ''}`,
      );
    }
    if (infra.deployScripts?.length) {
      L.push(
        `- ⚠ ${infra.deployScripts.length} hand-rolled deploy artifact(s) (not IaC): ${infra.deployScripts.map((d) => shortPath(d.file)).join(', ')}`,
      );
    }
    if (infra.external?.length)
      L.push(
        `- External processors (GDPR/AI-Act): ${infra.external.map((e) => e.provider).join(', ')}`,
      );
    L.push('');
  }

  // Git & Evolution
  const git = report.gitEvolution;
  if (git?.isRepo) {
    L.push('## Git & Evolution');
    L.push(
      `- ${git.commits.total} commits · ${git.branches.total} branch(es) (${git.branches.stale} stale) · ${git.tags} tags · ${git.commits.conventionalPct}% conventional`,
    );
    if (git.hotFiles?.length)
      L.push(
        `- Churn hotspots: ${git.hotFiles
          .slice(0, 10)
          .map((h) => `${shortPath(h.file)} (${h.churn})`)
          .join(', ')}`,
      );
    if (git.temporalCoupling?.length)
      L.push(
        `- Hidden coupling (co-change): ${git.temporalCoupling
          .slice(0, 6)
          .map((c) => `${shortPath(c.a)} ⇄ ${shortPath(c.b)} (${Math.round(c.confidence * 100)}%)`)
          .join(', ')}`,
      );
    if (git.busFactor)
      L.push(
        `- Bus factor: ${git.busFactor.singleAuthorFiles} single-author files · ${git.busFactor.topAuthors.map((a) => `${a.name} ${a.pct}%`).join(', ')}`,
      );
    L.push('');
  }

  // Recommended plan (selected phases, else all)
  const usePhases = selectedPhases.size
    ? selectedPhases
    : new Set(report.phases.map((p) => p.phase));
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const phases = report.phases
    .filter((p) => usePhases.has(p.phase))
    .sort((a, b) => a.phase - b.phase);
  if (phases.length) {
    L.push('## Recommended refactoring plan');
    L.push(
      selectedPhases.size
        ? `_Selected phases. Sequence foundations→consumers; each item as a Strangler-Fig (extract → repoint → delete, gated on grep-zero + a passing test)._`
        : `_All phases (select phases in the Plan tab to narrow)._`,
    );
    L.push('');
    for (const p of phases) {
      L.push(`### Phase ${p.phase} — ${p.name}`);
      if (p.why) L.push(`_${p.why}_`);
      const items = p.items
        .map((id) => byId.get(id))
        .filter((f): f is ScanFinding => !!f)
        .sort(
          (a, b) =>
            SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
            EFF_ORDER.indexOf(a.effort) - EFF_ORDER.indexOf(b.effort),
        )
        .slice(0, 30);
      items.forEach((f, i) =>
        L.push(
          `${i + 1}. **${f.severity}/${f.effort}** ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ''} (\`${f.location}\`)`,
        ),
      );
      if (p.items.length > 30) L.push(`   _…+${p.items.length - 30} more_`);
      L.push('');
    }
  }

  L.push('---');
  L.push(
    '_Generated by Futurator Refactoring Scan v2 — deterministic recon + LLM swarm. Report-only; no code was modified._',
  );
  return L.join('\n');
}

function downloadMarkdown(report: ScanReportData, appId: string, selectedPhases: Set<number>) {
  const md = buildMarkdownReport(report, appId, selectedPhases);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `code-quality-report-${appId}-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  onCreatePlan,
  onRescan,
  scanRunning,
}: {
  appId: string;
  onCreatePlan?: (intent: string) => void;
  /** Granular re-scan handler (parent POSTs scan-engine + tracks the job). */
  onRescan?: (input: RescanInput) => void;
  scanRunning?: boolean;
}) {
  // Self-loads the last persisted scan from S3 (keyed by appId) — survives reloads
  // without the producing job in the URL.
  const { data: report, isLoading } = useScanReport(appId);
  const [view, setView] = useState<ScanView>('overview');

  if (isLoading && !report) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        Loading scan report…
      </div>
    );
  }
  if (!report) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        No v2 scan yet. Run a scan to generate the dimension-tagged findings + phased plan.
      </div>
    );
  }

  return (
    <div data-testid="scan-report" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Header report={report} appId={appId} />
      {/* Module sub-tabs: Overview | Infrastructure | Security | Compliance |
          Architecture | Code quality | Testing | Plan. */}
      <div
        style={{
          display: 'inline-flex',
          flexWrap: 'wrap',
          alignSelf: 'flex-start',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {SCAN_TABS.map(([v, label]) => (
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

      {view === 'overview' ? (
        <>
          {report.stack ? <StackProfileHeader stack={report.stack} /> : null}
          {report.maturity?.readiness?.length ? (
            <ReadinessChecklist items={report.maturity.readiness} />
          ) : null}
          {report.maturity?.axes?.length ? (
            <MaturityScorecard axes={report.maturity.axes} overall={report.maturity.overall} />
          ) : null}
          {report.timeline?.length || report.cost ? (
            <TimelineCostPanel timeline={report.timeline} cost={report.cost} />
          ) : null}
          <ByDimension findings={report.findings} />
          {onRescan ? (
            <RerunParts report={report} onRescan={onRescan} scanRunning={scanRunning} />
          ) : null}
        </>
      ) : view === 'infra' ? (
        report.infra ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <ViewOnGraphLink dim="infra" />
            </div>
            <InfraMap
              infra={report.infra}
              complianceCount={report.counts.byDimension?.compliance ?? 0}
            />
          </div>
        ) : (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
            No infrastructure inventory in this scan — re-scan to generate it.
          </div>
        )
      ) : view === 'ai' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <ViewOnGraphLink dim="ai" />
          </div>
          <AiReadinessTab ai={report.aiReadiness} findings={report.findings} />
        </div>
      ) : view === 'git' ? (
        <GitTab git={report.gitEvolution} />
      ) : view === 'plan' ? (
        <>
          <PriorityMatrix findings={report.findings} />
          <Phases report={report} appId={appId} onCreatePlan={onCreatePlan} />
          <TimelineCostPanel timeline={report.timeline} cost={report.cost} />
        </>
      ) : MODULE_TABS[view] ? (
        <ModuleTab report={report} cfg={MODULE_TABS[view]} />
      ) : null}
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
  appId,
  onCreatePlan,
}: {
  report: ScanReportData;
  appId: string;
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
        <button
          type="button"
          onClick={() => downloadMarkdown(report, appId, selected)}
          data-testid="scan-export-md"
          title="Download a Markdown code-quality report (problems grouped + sorted + the selected-phase plan) to share with the codebase's agent"
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--foreground)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '5px 10px',
            cursor: 'pointer',
          }}
        >
          ⬇ Download MD report
        </button>
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
