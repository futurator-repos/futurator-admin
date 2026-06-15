'use client';
/**
 * /labs/skills/registry — Skills Management Phase 1, Story 1.3 (2026-06-15).
 *
 * The Skills Registry: browse + search every skill across the federation
 * (GET /api/skills/catalog), open a skill for its full metadata, and — given
 * ?appId= — see the on-disk ↔ federation drift (GET /api/skills/reconciliation).
 *
 * Sibling of /labs/skills (the per-app Usage dashboard); a tab links the two.
 */

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useSkillCatalog, type CatalogSkill } from '@/hooks/use-skill-catalog';
import { useSkillReconciliation } from '@/hooks/use-skill-reconciliation';

const mono = 'var(--font-mono)';
const muted = { fontSize: 12, color: 'var(--text-mute)' };

function Tabs({ appId }: { appId?: string }) {
  const usageHref = appId ? `/labs/skills?appId=${encodeURIComponent(appId)}` : '/labs/skills';
  return (
    <nav
      style={{
        display: 'flex',
        gap: 16,
        borderBottom: '1px solid var(--border)',
        marginBottom: 16,
      }}
    >
      <a
        href={usageHref}
        style={{
          fontSize: 13,
          padding: '8px 0',
          color: 'var(--text-mute)',
          textDecoration: 'none',
        }}
      >
        Usage
      </a>
      <span
        style={{
          fontSize: 13,
          padding: '8px 0',
          borderBottom: '2px solid var(--accent-blue, #3b82f6)',
          color: 'var(--text)',
        }}
      >
        Registry
      </span>
    </nav>
  );
}

function FrameworkBadge({ framework }: { framework: boolean }) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 4,
        background: framework ? 'var(--accent-blue-bg, #1e3a5f)' : 'var(--success-bg, #14532d)',
        color: framework ? 'var(--accent-blue, #60a5fa)' : 'var(--success, #4ade80)',
      }}
    >
      {framework ? 'bmad' : 'skill'}
    </span>
  );
}

function SkillDetail({ skill, onClose }: { skill: CatalogSkill; onClose: () => void }) {
  return (
    <aside
      style={{
        position: 'sticky',
        top: 16,
        alignSelf: 'start',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
        display: 'grid',
        gap: 10,
        background: 'var(--surface, #0f1115)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <code style={{ fontSize: 14, fontFamily: mono }}>{skill.name}</code>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-mute)',
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <FrameworkBadge framework={skill.framework} />
        <span style={muted}>
          {skill.kind} · {skill.license}
        </span>
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
        {skill.description || '— no description —'}
      </p>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: 11,
          fontFamily: mono,
          margin: 0,
        }}
      >
        <dt style={{ color: 'var(--text-faint)' }}>source</dt>
        <dd style={{ margin: 0 }}>
          {skill.source}{' '}
          {skill.autoTrust ? (
            <span style={{ color: 'var(--success, #4ade80)' }}>· auto-trust</span>
          ) : null}
        </dd>
        <dt style={{ color: 'var(--text-faint)' }}>version</dt>
        <dd style={{ margin: 0 }}>{skill.version}</dd>
      </dl>
    </aside>
  );
}

function DriftPanel({ appId }: { appId: string }) {
  const { data, isLoading, error } = useSkillReconciliation(appId);
  if (isLoading) return <p style={muted}>Loading drift for {appId}…</p>;
  if (error || !data)
    return (
      <p style={{ ...muted, color: 'var(--warning, #f59e0b)' }}>Drift unavailable for {appId}.</p>
    );
  const chip = (label: string, n: number, color: string) => (
    <span style={{ fontFamily: mono, fontSize: 11, color }}>
      {label} <strong>{n}</strong>
    </span>
  );
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 16,
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Drift · {appId}</strong>
        {data.inSync ? (
          <span style={{ fontSize: 11, color: 'var(--success, #4ade80)' }}>✓ in sync</span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>
            ⚠ {data.unmanaged.length} unmanaged
          </span>
        )}
        {chip('on-disk', data.onDiskCount, 'var(--text-mute)')}
        {chip('managed', data.managed.length, 'var(--success, #4ade80)')}
        {chip('unmanaged', data.unmanaged.length, 'var(--warning, #f59e0b)')}
        {chip('not-loaded', data.availableNotLoaded.length, 'var(--text-faint)')}
      </div>
      {data.unmanaged.length > 0 && (
        <p style={{ fontSize: 11, fontFamily: mono, color: 'var(--warning, #f59e0b)', margin: 0 }}>
          unmanaged: {data.unmanaged.join(', ')}
        </p>
      )}
    </div>
  );
}

function RegistryContent() {
  const params = useSearchParams();
  const appId = params.get('appId') || undefined;
  const { data, isLoading, error } = useSkillCatalog();
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'bmad' | 'skill'>('all');
  const [selected, setSelected] = useState<CatalogSkill | null>(null);

  const sources = useMemo(() => [...new Set((data?.skills ?? []).map((s) => s.source))], [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.skills ?? []).filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false;
      if (frameworkFilter === 'bmad' && !s.framework) return false;
      if (frameworkFilter === 'skill' && s.framework) return false;
      if (
        needle &&
        !s.name.toLowerCase().includes(needle) &&
        !s.description.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [data, q, sourceFilter, frameworkFilter]);

  return (
    <div style={{ padding: '16px 0' }}>
      <Tabs appId={appId} />
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Skill Registry</h1>
        <p style={{ ...muted, margin: '4px 0 0' }}>
          {isLoading
            ? 'Loading catalog…'
            : error
              ? 'Failed to load catalog.'
              : `${data?.skills.length ?? 0} skills across ${sources.length} source(s)`}
          {data?.sources?.some((s) => !s.ok) && (
            <span style={{ color: 'var(--warning, #f59e0b)' }}>
              {' '}
              · {data.sources.filter((s) => !s.ok).length} source(s) failed
            </span>
          )}
        </p>
      </header>

      {appId && <DriftPanel appId={appId} />}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or description…"
          style={{
            flex: '1 1 240px',
            fontSize: 13,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface, #0f1115)',
            color: 'var(--text)',
          }}
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="all">all sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={frameworkFilter}
          onChange={(e) => setFrameworkFilter(e.target.value as 'all' | 'bmad' | 'skill')}
          style={selectStyle}
        >
          <option value="all">all kinds</option>
          <option value="bmad">bmad only</option>
          <option value="skill">non-bmad only</option>
        </select>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: selected ? '1fr 320px' : '1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <table
          style={{ width: '100%', fontFamily: mono, fontSize: 12, borderCollapse: 'collapse' }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-faint)' }}>
              <th style={th}>Skill</th>
              <th style={th}>Kind</th>
              <th style={th}>Source</th>
              <th style={th}>License</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr
                key={`${s.name}@${s.source}`}
                onClick={() => setSelected(s)}
                style={{
                  borderTop: '1px solid var(--border)',
                  cursor: 'pointer',
                  background:
                    selected?.name === s.name ? 'var(--surface-hover, #1a1d24)' : 'transparent',
                }}
              >
                <td style={td}>
                  {s.name}
                  <div
                    style={{
                      fontFamily: 'inherit',
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontWeight: 400,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: 360,
                    }}
                  >
                    {s.description}
                  </div>
                </td>
                <td style={td}>
                  <FrameworkBadge framework={s.framework} />
                </td>
                <td style={{ ...td, color: 'var(--text-mute)' }}>{s.source}</td>
                <td
                  style={{
                    ...td,
                    color: s.license === 'UNKNOWN' ? 'var(--warning, #f59e0b)' : 'var(--text-mute)',
                  }}
                >
                  {s.license}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !isLoading && (
              <tr>
                <td colSpan={4} style={{ ...td, color: 'var(--text-faint)' }}>
                  No skills match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {selected && <SkillDetail skill={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface, #0f1115)',
  color: 'var(--text)',
};
const th: React.CSSProperties = { padding: '4px 8px 4px 0', fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px 6px 0', verticalAlign: 'top' };

export default function SkillsRegistryPage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<p style={{ padding: 16, ...muted }}>Loading…</p>}>
          <RegistryContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
