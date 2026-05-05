'use client';

/**
 * Inline "coming soon" card listing the Deploy features we've deliberately
 * scoped OUT of v1. Keeps expectations clear without hiding the roadmap.
 *
 * Edit this list as features ship — don't let it become stale.
 */

const DEFERRED: Array<{ title: string; note: string }> = [
  {
    title: 'Versioned releases + rollback',
    note: 'Each deploy goes to `apps/<slug>/v<timestamp>/` with a pointer object. Rollback flips the pointer and invalidates — safe + fast.',
  },
  {
    title: 'Preview environments',
    note: 'Per-branch preview URLs under a subdomain. Current spec ships everything to the same route.',
  },
  {
    title: 'Post-deploy smoke tests',
    note: 'Automated smoke check after publish (curl + parse). Right now the agent verifies only during deploy.',
  },
  {
    title: 'Two-person approvals',
    note: 'Second reviewer required for production releases. Overkill for now; worth revisiting once volume picks up.',
  },
  {
    title: 'Post-launch metrics',
    note: 'Uptime, traffic, error rate — belongs on the Published pipeline stage once app is live.',
  },
];

export function DeferredFeatures() {
  return (
    <details
      style={{
        border: '1px dashed var(--border-2)',
        background:
          'color-mix(in srgb, var(--foreground) 1%, transparent)',
        borderRadius: 8,
        padding: '12px 16px',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-mute)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        <span>Deferred features ({DEFERRED.length})</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 9 }}>
          Click to expand the Deploy roadmap
        </span>
      </summary>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '12px 0 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {DEFERRED.map((d) => (
          <li
            key={d.title}
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr',
              gap: 12,
              paddingTop: 8,
              borderTop: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-dim)',
                fontWeight: 500,
                letterSpacing: '-0.005em',
              }}
            >
              {d.title}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-mute)',
                lineHeight: 1.5,
              }}
            >
              {d.note}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
