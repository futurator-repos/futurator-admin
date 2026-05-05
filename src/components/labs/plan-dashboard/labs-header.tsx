'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { ProjectSelector } from './project-selector';
import { DeletePlanModal } from '@/components/labs/plans/delete-plan-modal';
import { usePlan } from '@/hooks/use-plans';
import type { PlanSummary } from '@/types/plan';

/**
 * Labs header — sits inside AppShell's <main>. Contains the L A B S wordmark,
 * the Project Selector, and the Delete-plan affordance (PR-10 #3). The two
 * runtime panels (Daemon actions + Claude Code auth) live in the global app
 * header so they're visible on every page.
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
        <DeletePlanButton currentPlanId={currentPlanId} />
      </div>
    </header>
  );
}

/**
 * PR-10 #3 — small destructive affordance in the labs header. Opens the
 * existing DeletePlanModal which already handles cascade delete + the
 * type-the-slug-to-confirm pattern. v1-aware copy in the modal warns that
 * the App's working tree is preserved (see DeletePlanModal).
 */
function DeletePlanButton({ currentPlanId }: { currentPlanId: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { data: plan } = usePlan(currentPlanId);
  if (!plan) return null;

  // The modal expects a PlanSummary shape — we have the full Plan, which is
  // a strict superset of PlanSummary. Cast through the relevant fields only.
  const summary: PlanSummary & { appId?: string } = {
    planId: plan.planId,
    name: plan.name,
    displayName: plan.displayName,
    intent: plan.intent,
    status: plan.status,
    totalStories: plan.totalStories,
    doneStories: plan.doneStories,
    totalCostUsd: plan.totalCostUsd,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    archivedAt: plan.archivedAt,
    deployUrl: plan.deployUrl,
    appId: (plan as typeof plan & { appId?: string }).appId,
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Delete this plan"
        aria-label="Delete plan"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-mute)',
          background: 'transparent',
          border: '1px solid var(--border-2)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--destructive)';
          e.currentTarget.style.borderColor = 'var(--destructive)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-mute)';
          e.currentTarget.style.borderColor = 'var(--border-2)';
        }}
      >
        <Trash2 size={12} />
        Delete
      </button>
      <DeletePlanModal
        plan={summary}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => {
          // Bounce back to the App detail (or Apps grid) after deletion so
          // the operator doesn't sit on a 404'd plan dashboard.
          if (summary.appId) {
            router.push(`/labs?appId=${encodeURIComponent(summary.appId)}`);
          } else {
            router.push('/labs');
          }
        }}
      />
    </>
  );
}
