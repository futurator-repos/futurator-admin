'use client';

/**
 * Developing sub-tabs — shown only while viewing the Developing stage.
 *
 * Three views: Hierarchy, Kanban, Gantt. Deploy lives on its own Pipeline
 * stage (reached via "Promote to Deploy" from QA Review or by clicking the
 * Deploy node in the pipeline bar). Party Mode is a top-level pipeline
 * button.
 *
 * Note: `'deploy'` retained in DevelopingSubtab union for backward-compat
 * with any persisted `?subtab=deploy` URLs in user history; it just no
 * longer surfaces as a tab.
 */

export type DevelopingSubtab = 'hierarchy' | 'kanban' | 'gantt' | 'deploy';

const SUBTABS: { id: DevelopingSubtab; label: string }[] = [
  { id: 'hierarchy', label: 'Hierarchy' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'gantt', label: 'Gantt' },
];

export function DevelopingSubtabs({
  active,
  onChange,
}: {
  active: DevelopingSubtab;
  onChange: (t: DevelopingSubtab) => void;
}) {
  return (
    <div style={{ padding: '28px 0 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {SUBTABS.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-dim)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-mute)';
              }}
              style={{
                padding: '14px 24px',
                fontSize: 12,
                color: on ? 'var(--foreground)' : 'var(--text-mute)',
                fontWeight: 400,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                borderBottom: `1px solid ${on ? 'var(--foreground)' : 'transparent'}`,
                marginBottom: -1,
                background: 'transparent',
                border: 'none',
                borderBottomStyle: 'solid',
                cursor: 'pointer',
                transition: 'color 150ms, border-color 150ms',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
