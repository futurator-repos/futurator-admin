'use client';
import { ProjectSelector } from './project-selector';
import { RuntimeControls } from '@/components/labs/runtime-controls';

/**
 * Labs header — sits inside AppShell's <main>. Contains the L A B S wordmark,
 * the Project Selector, and the two runtime panels (Daemon actions + Claude
 * Code auth) on the right.
 */
export function LabsHeader({ currentPlanId }: { currentPlanId: string }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '18px 0 22px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <h1
          style={{
            fontSize: 17,
            fontWeight: 300,
            color: 'var(--foreground)',
            letterSpacing: '0.42em',
            textTransform: 'uppercase',
            margin: 0,
          }}
        >
          L A B S
        </h1>
        <span style={{ width: 1, height: 14, background: 'var(--border-2)' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Plans
        </span>
      </div>
      <div style={{ marginLeft: 8 }}>
        <ProjectSelector currentPlanId={currentPlanId} />
      </div>
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <RuntimeControls />
      </div>
    </header>
  );
}
