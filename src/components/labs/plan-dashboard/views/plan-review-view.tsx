'use client';

/**
 * Plan Review view — shown for plans in the Concept stage.
 *
 * Purpose: present what the PM proposed (epics → waves → stories) and let the
 * operator either Regenerate or Start development. Designed for review, not
 * live monitoring (that's the Hierarchy view under the Developing stage).
 *
 * Ported from the layout pattern of the legacy plan-detail.tsx → Plan tab.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlanWithEpics } from '@/hooks/use-plans';
import { ConceptRail } from './concept-rail';
import { ConceptDocDrawer } from './concept-doc-drawer';
import { ConceptTimingPanel } from './concept-timing-panel';
import type { ConceptArtifactKind } from '@/types/plan';
import {
  usePatchPlan,
  useRegeneratePlan,
  useStartPlan,
  useExportPlan,
  useImportPlan,
  usePmPrompt,
} from '@/hooks/use-plans';
import { useAttentionItems } from '@/hooks/use-attention-items';
import {
  useApproveConceptArtifact,
  useRegenerateConceptArtifact,
  useConceptDrive,
} from '@/hooks/use-concept-artifacts';
import type { AgentJobStatus, AgentEvent } from '@/types/agent-orchestrator';
import { api } from '@/lib/api-client';
import type { EpicWorkflow } from '@/types/epic-workflow';
import { epicStatusColor } from '../constants';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';
import {
  SkillScoutCard,
  type SkillScoutCardContext,
} from '@/components/labs/skill-scout/skill-scout-card';
import { PlanEditorModal, planOutputToDraft, type PlanDraft } from './plan-editor-modal';

interface Props {
  plan: PlanWithEpics;
  pmJobStatus?: AgentJobStatus;
  pmJobId?: string | null;
  applyPending?: boolean;
  /** dino1/snake (2026-06-12) — the apply/validation rejection message, so
   *  a PM plan that fails validation is explained instead of silently
   *  rendering the empty "No epics yet" state. */
  applyError?: string | null;
  onPmJobStarted?: (jobId: string) => void;
  onPlanStarted?: () => void;
}

export function PlanReviewView({
  plan,
  pmJobStatus,
  pmJobId,
  applyPending,
  applyError,
  onPmJobStarted,
  onPlanStarted,
}: Props) {
  const epics = plan.epics ?? [];
  const hasEpics = epics.length > 0;
  const isConcept = plan.status === 'concept';
  const pmRunning = pmJobStatus === 'PENDING' || pmJobStatus === 'RUNNING';
  const pmFailed = pmJobStatus === 'FAILED';
  // Concept v2 — when the Concept chain owns this plan, the PM does NOT run
  // until every spec is approved. The rail is the source of truth for "what's
  // running"; the legacy PM banner/empty-state must NOT show (it falsely read
  // the concept-apply mutation's transient isPending as "PM drafting").
  // A `conceptRouteJobId` is stamped at CREATION, so we treat the chain as
  // active from the very first render — even before the Router finishes and
  // `conceptPlan` is applied — to suppress the false "PM drafting" banner
  // during the routing window. `conceptRouting` = chain owns it but no plan yet.
  const conceptChainActive = isConcept && (!!plan.conceptPlan || !!plan.conceptRouteJobId);
  const conceptRouting = conceptChainActive && !plan.conceptPlan;
  // Which specialized BMAD persona is actively drafting right now (for the live
  // stream header). The active artifact = first non-approved in topo order; it's
  // generating when rev0. We stream THAT generator job's stream-json trace.
  const conceptArtifactsList = plan.conceptArtifacts ?? [];
  const activeConceptKind = plan.conceptPlan?.artifacts.find((p) => {
    const r = conceptArtifactsList.find((a) => a.kind === p.kind);
    return !r || r.status !== 'approved';
  })?.kind;
  const activeConceptArtifact = activeConceptKind
    ? conceptArtifactsList.find((a) => a.kind === activeConceptKind)
    : undefined;
  const conceptGenerating =
    !!activeConceptArtifact &&
    activeConceptArtifact.status === 'draft' &&
    activeConceptArtifact.rev === 0;
  const generating = (pmRunning || !!applyPending) && !conceptChainActive;
  // The epic plan is the LAST step — it's only valid once every spec is approved.
  // Until then we hide the epics list (any epics present on a chain plan are
  // stale/premature, e.g. from a legacy monolithic-PM run) and keep the rail +
  // "drafting your specs" state as the surface. Non-concept plans are unaffected.
  const specsComplete =
    !conceptChainActive ||
    ((plan.conceptPlan?.artifacts ?? []).length > 0 &&
      (plan.conceptPlan?.artifacts ?? []).every(
        (p) => conceptArtifactsList.find((a) => a.kind === p.kind)?.status === 'approved',
      ));
  // Reactive drive: advance the spec chain while the operator watches (the cron
  // is the backstop). Active until every spec is approved + the plan is drafted.
  useConceptDrive(plan.planId, conceptChainActive && !specsComplete);

  const patch = usePatchPlan(plan.planId);
  const regenerate = useRegeneratePlan(plan.planId);
  const start = useStartPlan(plan.planId);
  const approveArtifact = useApproveConceptArtifact(plan.planId);
  const regenerateArtifact = useRegenerateConceptArtifact(plan.planId);
  const [docDrawerKind, setDocDrawerKind] = useState<ConceptArtifactKind | null>(null);
  const qc = useQueryClient();

  // SKILL-SCOUT gate (Epic 3 Story 3.5): plan /start returns 409 while an
  // open `manifest-change-proposed` decision card exists. Surface the card
  // inline here — right beside Start development — so the gate is resolvable
  // at the point of friction instead of only via the attention bell.
  const attention = useAttentionItems(plan.planId);
  const openScoutCard = (attention.data?.items ?? []).find(
    (it) => it.category === 'manifest-change-proposed' && it.status !== 'resolved',
  );
  const [startError, setStartError] = useState<string | null>(null);

  // Intent editor — kept in sync with server state. The effect handles
  // external updates (regenerate from another tab, or a polled refetch
  // returning a different intent). We only sync when the local draft is
  // pristine, otherwise we'd clobber the user's in-progress edit.
  const [intentDraft, setIntentDraft] = useState<string>(plan.intent);
  const [draftAnchor, setDraftAnchor] = useState<string>(plan.intent);
  useEffect(() => {
    if (intentDraft === draftAnchor) {
      setIntentDraft(plan.intent);
    }
    setDraftAnchor(plan.intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.intent]);
  const intentDirty = intentDraft !== plan.intent;
  const canEditIntent = isConcept && !generating;

  async function saveIntent() {
    if (!intentDirty) return;
    try {
      await patch.mutateAsync({ intent: intentDraft });
    } catch (err) {
      console.error('[PlanReview] saveIntent', err);
    }
  }

  async function handleRegenerate() {
    if (intentDirty) await saveIntent();
    try {
      const result = await regenerate.mutateAsync();
      onPmJobStarted?.(result.pmJobId);
    } catch (err) {
      console.error('[PlanReview] regenerate', err);
    }
  }

  async function handleStart() {
    setStartError(null);
    try {
      await start.mutateAsync();
      onPlanStarted?.();
    } catch (err) {
      console.error('[PlanReview] start', err);
      // Refetch attention so the gating card appears inline immediately.
      qc.invalidateQueries({ queryKey: ['attention-items', plan.planId] });
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Plan portability (2026-06-11): export / edit / import / external LLM ──
  const exportPlan = useExportPlan(plan.planId);
  const importPlan = useImportPlan(plan.planId);
  const pmPrompt = usePmPrompt(plan.planId);
  const [jsonModal, setJsonModal] = useState<{ mode: 'edit' | 'import'; initial: string } | null>(
    null,
  );
  const [editorDraft, setEditorDraft] = useState<PlanDraft | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const canMutatePlan = isConcept && !generating;

  async function handleExportDownload() {
    try {
      const data = await exportPlan.mutateAsync();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${plan.name}-plan.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[PlanReview] export', err);
    }
  }

  async function handleEditPlan() {
    try {
      const data = await exportPlan.mutateAsync();
      setEditorDraft(
        planOutputToDraft({ plan: data.plan as Parameters<typeof planOutputToDraft>[0]['plan'] }),
      );
    } catch (err) {
      console.error('[PlanReview] edit-plan', err);
    }
  }

  async function handleCopyPmPrompt() {
    try {
      const data = await pmPrompt.mutateAsync();
      await navigator.clipboard.writeText(data.prompt);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2500);
    } catch (err) {
      console.error('[PlanReview] copy-prompt', err);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Intent card */}
      <section
        style={{
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          padding: '18px 22px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <SectionHeader>Intent</SectionHeader>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {intentDirty && canEditIntent && (
              <GhostButton
                label={patch.isPending ? 'Saving…' : 'Save'}
                onClick={() => saveIntent()}
                disabled={patch.isPending}
              />
            )}
            {/* The monolithic PM `Regenerate` is the LEGACY one-shot — it makes a
                single "PM" agent author the PRD, UX, architecture AND the plan
                all at once. For a Concept-chain plan that's wrong: the chain
                runs specialized BMAD personas (John→PRD, Sally→UX, Winston→Arch)
                each owning their artifact, with per-doc Regenerate in the rail.
                So hide the monolithic button whenever the chain owns the plan. */}
            {isConcept && !conceptChainActive && (
              <GhostButton
                label={regenerate.isPending ? 'Starting…' : 'Regenerate'}
                onClick={handleRegenerate}
                disabled={regenerate.isPending || generating}
              />
            )}
            {/* Start development moved OUT of this header into the dedicated
                Concept Gate card at the foot of the page (Murat's gate), shown
                once the epic plan is drafted. */}
          </div>
        </div>
        <textarea
          value={intentDraft}
          onChange={(e) => setIntentDraft(e.target.value)}
          readOnly={!canEditIntent}
          rows={Math.min(10, Math.max(3, intentDraft.split('\n').length + 1))}
          style={{
            width: '100%',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '10px 12px',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--foreground)',
            fontFamily: 'var(--font-sans)',
            resize: 'vertical',
            outline: 'none',
            cursor: canEditIntent ? 'text' : 'default',
            opacity: canEditIntent ? 1 : 0.85,
          }}
        />
      </section>

      {/* SKILL-SCOUT decision card — the gate that blocks /start. Rendered
          inline so the operator resolves it (confirm/decline/defer) right
          here; resolving clears the 409 and re-enables Start development. */}
      {openScoutCard && (
        <section>
          <SectionHeader style={{ marginBottom: 8 }}>
            Skill manifest — decision required before start
          </SectionHeader>
          <SkillScoutCard
            itemId={openScoutCard.itemId}
            planId={plan.planId}
            context={openScoutCard.context as unknown as SkillScoutCardContext}
            onResolved={() => {
              setStartError(null);
              qc.invalidateQueries({ queryKey: ['attention-items', plan.planId] });
            }}
          />
        </section>
      )}

      {/* Start error (e.g. the SKILL-SCOUT 409) surfaced inline. */}
      {startError && !openScoutCard && (
        <div
          style={{
            border: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            color: 'var(--destructive)',
            borderRadius: 8,
            padding: '14px 18px',
            fontSize: 13,
          }}
        >
          Couldn’t start the plan: {startError}
        </div>
      )}

      {/* PM-running / failed banner */}
      {generating && <GeneratingBanner pmJobId={pmJobId} />}
      {pmFailed && !generating && !hasEpics && <FailedBanner />}

      {/* PR-9 #2 — PM agent live logs. Reuses StoryLiveOutput so the
          Concept stage gets the same auditable stream the dev/reviewer
          stages already had. Visible whenever there's a PM job (running,
          completed, or failed); collapsed by default once epics land so
          the operator sees the structure first, the trace on demand. */}
      {pmJobId && <PmAgentLogPanel jobId={pmJobId} defaultOpen={!hasEpics || generating} />}

      {/* Plan portability toolbar — export / edit / import / external LLM. */}
      {isConcept && (
        <section
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <SectionHeader>Plan JSON</SectionHeader>
          {hasEpics && (
            <GhostButton
              label={exportPlan.isPending ? 'Exporting…' : 'Export'}
              onClick={handleExportDownload}
              disabled={exportPlan.isPending}
            />
          )}
          {hasEpics && (
            <GhostButton
              label="Edit plan"
              onClick={handleEditPlan}
              disabled={!canMutatePlan || exportPlan.isPending}
            />
          )}
          <GhostButton
            label="Import"
            onClick={() => setJsonModal({ mode: 'import', initial: '' })}
            disabled={!canMutatePlan}
          />
          <GhostButton
            label={promptCopied ? 'Copied ✓' : 'Copy LLM prompt'}
            onClick={handleCopyPmPrompt}
            disabled={pmPrompt.isPending}
          />
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Generate the plan with any external LLM: copy the prompt, paste its JSON via Import.
          </span>
        </section>
      )}

      {jsonModal && (
        <PlanJsonModal
          mode={jsonModal.mode}
          initial={jsonModal.initial}
          pending={importPlan.isPending}
          onCancel={() => setJsonModal(null)}
          onSubmit={async (text) => {
            await importPlan.mutateAsync(text);
            setJsonModal(null);
          }}
        />
      )}

      {editorDraft && (
        <PlanEditorModal
          initial={editorDraft}
          pending={importPlan.isPending}
          onCancel={() => setEditorDraft(null)}
          onSubmit={async (planJson) => {
            await importPlan.mutateAsync(planJson);
            setEditorDraft(null);
          }}
        />
      )}

      {/* Epics list */}
      <section>
        <SectionHeader style={{ marginBottom: 10 }}>
          Epics{hasEpics && <span style={{ opacity: 0.5 }}> · {epics.length}</span>}
        </SectionHeader>

        {/* dino1/snake (2026-06-12) — a completed PM whose plan failed
            validation used to land here as a bare "No epics yet" with the
            real reason buried in the console. Show the rejection loudly:
            the operator regenerates (a fresh PM roll) or fixes + Imports. */}
        {!hasEpics && applyError && !generating && (
          <div
            style={{
              padding: '14px 16px',
              border: '1px solid var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 7%, transparent)',
              borderRadius: 8,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: 'var(--text-dim)',
              marginBottom: 10,
            }}
          >
            <div style={{ color: 'var(--destructive)', fontWeight: 600, marginBottom: 4 }}>
              The PM finished, but its plan was rejected by validation
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap' }}>
              {applyError}
            </div>
            <div style={{ marginTop: 8, color: 'var(--text-mute)' }}>
              Click <strong>Regenerate</strong> for a fresh decomposition, or fix the JSON and use{' '}
              <strong>Import</strong>.
            </div>
          </div>
        )}

        {conceptRouting && (
          <div
            data-testid="concept-routing"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '16px 20px',
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--bg-elev)',
              marginBottom: 16,
            }}
          >
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--accent-purple)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Routing your concept…</div>
              <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 2 }}>
                Mary is deciding which specs this build needs (PRD · UX · Architecture). The chain
                appears here as soon as routing finishes.
              </div>
            </div>
          </div>
        )}

        {isConcept && plan.conceptPlan && (
          <ConceptRail
            conceptPlan={plan.conceptPlan}
            conceptArtifacts={plan.conceptArtifacts}
            onApprove={(kind) => approveArtifact.mutate(kind)}
            approvingKind={approveArtifact.isPending ? approveArtifact.variables : null}
            onRegenerate={(kind) => regenerateArtifact.mutate(kind)}
            regeneratingKind={regenerateArtifact.isPending ? regenerateArtifact.variables : null}
            onView={(kind) => setDocDrawerKind(kind)}
          />
        )}

        {docDrawerKind && (
          <ConceptDocDrawer
            planId={plan.planId}
            kind={docDrawerKind}
            onClose={() => setDocDrawerKind(null)}
            onApprove={(kind) => {
              approveArtifact.mutate(kind, { onSuccess: () => setDocDrawerKind(null) });
            }}
            onRegenerate={(kind) => regenerateArtifact.mutate(kind)}
            approving={approveArtifact.isPending}
            regenerating={regenerateArtifact.isPending}
          />
        )}

        {conceptChainActive && <ConceptTimingPanel plan={plan} />}

        {/* Persistent, collapsible per-agent traces (Mary/John/Sally/Winston) —
            the active one streams live + auto-expands; completed ones are
            retained (collapsed) so nothing is lost between docs. Plus a
            forensic log download for the whole concept stage. */}
        {conceptChainActive && (
          <ConceptAgentLogs
            plan={plan}
            activeKind={conceptGenerating ? activeConceptKind : undefined}
          />
        )}

        {/* Concept chain owns generation — the rail above is the live status.
            Show a chain-aware caption instead of the legacy PM empty-state. */}
        {conceptChainActive && !specsComplete && (
          <EmptyCard faded>
            Drafting your specs — approve PRD, UX &amp; Architecture above, then the epic plan is
            generated from the approved docs. (The plan appears here only after every spec is
            approved.)
          </EmptyCard>
        )}

        {!conceptChainActive && !hasEpics && !generating && !pmFailed && !applyError && (
          <EmptyCard>
            No epics yet. Click <strong>Regenerate</strong> to kick off the PM agent.
          </EmptyCard>
        )}

        {!conceptChainActive && generating && !hasEpics && (
          <EmptyCard faded>PM is drafting epics…</EmptyCard>
        )}

        {hasEpics && specsComplete && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {epics.map((e, idx) => (
              <EpicRow key={e.epicId} epic={e} label={`E${idx + 1}`} allEpics={epics} />
            ))}
          </div>
        )}
      </section>

      {/* Concept gate (Murat) — the single forward door out of Concept. It
          appears once the epic plan is drafted (all specs approved + epics
          landed) and is where the operator approves the plan to begin the
          Developing stage. Relocated here from the Intent header + redesigned
          as a deliberate gate, so "Start development" is an explicit decision
          at the end of the chain, not a stray button at the top. */}
      {isConcept && hasEpics && specsComplete && (
        <ConceptGateCard
          gate={plan.conceptPlan?.gate ?? 'light'}
          epicCount={epics.length}
          storyCount={epics.reduce((n, e) => n + e.stories.length, 0)}
          blocked={!!openScoutCard}
          pending={start.isPending}
          disabled={generating}
          onStart={handleStart}
        />
      )}
    </div>
  );
}

/**
 * Concept gate — Murat's review door. A summary of the drafted plan plus the
 * one button that promotes it into Developing. When a SKILL-SCOUT decision card
 * is open it's blocked (resolve it above first); the actual /start call still
 * runs the server-side gate (skill manifest 409 etc.).
 */
function ConceptGateCard({
  gate,
  epicCount,
  storyCount,
  blocked,
  pending,
  disabled,
  onStart,
}: {
  gate: 'noop' | 'light' | 'strict';
  epicCount: number;
  storyCount: number;
  blocked: boolean;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <section
      data-testid="concept-gate"
      style={{
        border: '1px solid color-mix(in srgb, var(--accent-purple) 35%, var(--border))',
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--accent-purple) 7%, transparent), transparent)',
        borderRadius: 12,
        padding: '20px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          flexShrink: 0,
          background: 'color-mix(in srgb, var(--accent-purple) 14%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent-purple) 45%, transparent)',
        }}
      >
        🧪
      </div>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            Concept gate
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-faint)',
              letterSpacing: '0.1em',
            }}
          >
            Murat · gate: {gate}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.5 }}>
          The plan is drafted from the approved specs — <strong>{epicCount}</strong> epic
          {epicCount === 1 ? '' : 's'}, <strong>{storyCount}</strong> stor
          {storyCount === 1 ? 'y' : 'ies'}. Approving promotes this plan into the Developing stage.
          {blocked && (
            <span style={{ color: 'var(--warning)' }}>
              {' '}
              Resolve the skill-manifest card above before starting.
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        data-testid="concept-gate-start"
        onClick={onStart}
        disabled={pending || disabled || blocked}
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.04em',
          padding: '10px 20px',
          border: '1px solid var(--foreground)',
          borderRadius: 6,
          color: 'var(--background)',
          background: 'var(--foreground)',
          cursor: pending || disabled || blocked ? 'not-allowed' : 'pointer',
          opacity: pending || disabled || blocked ? 0.55 : 1,
          flexShrink: 0,
        }}
      >
        {pending
          ? 'Launching…'
          : blocked
            ? 'Resolve skill card first'
            : 'Approve & start development →'}
      </button>
    </section>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

function EpicRow({
  epic,
  label,
  allEpics,
}: {
  epic: EpicWorkflow;
  label: string;
  allEpics: EpicWorkflow[];
}) {
  const color = epicStatusColor(epic.status);
  const storiesByWave = new Map<number, typeof epic.stories>();
  for (const s of epic.stories) {
    const w = s.wave ?? 0;
    if (!storiesByWave.has(w)) storiesByWave.set(w, []);
    storiesByWave.get(w)!.push(s);
  }
  const waveNumbers = [...storiesByWave.keys()].sort((a, b) => a - b);
  const depLabels = (epic.dependsOnEpics ?? []).map((id) => {
    const idx = allEpics.findIndex((x) => x.epicId === id);
    return idx >= 0 ? `E${idx + 1}` : id;
  });
  const doneCount = epic.stories.filter((s) => s.status === 'done').length;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 6,
        padding: '14px 18px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            border: '1px solid var(--border-2)',
            padding: '2px 8px',
            borderRadius: 2,
            flexShrink: 0,
          }}
        >
          PW{epic.epicWave ?? 0}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
            letterSpacing: '0.08em',
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 15,
            fontWeight: 400,
            color: 'var(--foreground)',
            letterSpacing: '-0.005em',
            flex: 1,
            minWidth: 220,
          }}
        >
          {epic.title}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            flexShrink: 0,
          }}
        >
          {epic.status.replace('_', ' ')}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.04em',
            flexShrink: 0,
          }}
        >
          {doneCount}/{epic.stories.length}
        </span>
      </div>

      {epic.description && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-dim)',
            lineHeight: 1.55,
            marginBottom: 8,
            textWrap: 'pretty',
          }}
        >
          {epic.description}
        </p>
      )}

      {depLabels.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: 12,
          }}
        >
          depends on: <span style={{ color: 'var(--text-dim)' }}>{depLabels.join(', ')}</span>
        </div>
      )}

      {/* Waves */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {waveNumbers.map((w) => {
          const items = storiesByWave.get(w) ?? [];
          const parallel = items.length > 1;
          return (
            <div
              key={w}
              style={{
                background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '8px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--accent-purple)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.22em',
                    padding: '2px 6px',
                    borderRadius: 2,
                    background: 'color-mix(in srgb, var(--accent-purple) 10%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-purple) 22%, transparent)',
                  }}
                >
                  Wave {w}
                </span>
                {parallel ? (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--accent-purple)',
                      letterSpacing: '0.12em',
                    }}
                  >
                    ⚡ {items.length} parallel
                  </span>
                ) : (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--text-mute)',
                      letterSpacing: '0.12em',
                    }}
                  >
                    1 story
                  </span>
                )}
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {items.map((story) => (
                  <StoryWithCriteria
                    key={story.storyId}
                    story={story}
                    // Epic-local sequential number (was per-wave index — every
                    // wave's first story rendered as "S1").
                    label={`S${(story.order ?? 0) + 1}`}
                    allStories={epic.stories}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * PR-9 #3 — render a story row with collapsible AC list. Operator clicks
 * the row to expand and see the criteria the PM emitted. Resolves the
 * "PM gave me 4 stories with no visible structure" complaint — the
 * structure was always there in story.criteria[], just not surfaced on
 * the Concept stage.
 *
 * AC count badge always visible so operator can sanity-check rigor density
 * (prototype: 1-3 ACs/story; mvp: 3-5; production: 4-6).
 */
function StoryWithCriteria({
  story,
  label,
  allStories,
}: {
  story: EpicWorkflow['stories'][number];
  label: string;
  /** Sibling stories in the same epic — resolves dependsOn UUIDs to labels. */
  allStories: EpicWorkflow['stories'];
}) {
  const [expanded, setExpanded] = useState(false);
  const criteria = story.criteria ?? [];
  const hasCriteria = criteria.length > 0;
  const depLabels = (story.dependsOn ?? [])
    .map((id) => {
      const dep = allStories.find((s) => s.storyId === id);
      return dep ? `S${(dep.order ?? 0) + 1} — ${dep.title}` : null;
    })
    .filter((s): s is string => !!s);
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: 'var(--foreground)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '3px 0',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          color: 'inherit',
          cursor: 'pointer',
          width: '100%',
          fontSize: 13,
        }}
      >
        <StoryDot status={story.status} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.08em',
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {story.title}
        </span>
        {hasCriteria ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-faint)',
              letterSpacing: '0.12em',
              border: '1px solid var(--border)',
              padding: '1px 6px',
              borderRadius: 2,
              flexShrink: 0,
            }}
            title="Acceptance criteria — click to expand"
          >
            {criteria.length} AC{criteria.length === 1 ? '' : 's'} {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--destructive)',
              letterSpacing: '0.12em',
              flexShrink: 0,
            }}
            title="PM did not emit acceptance criteria for this story"
          >
            no AC
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{ padding: '6px 0 8px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {/* Full story description — human-readable prose, never truncated. */}
          {story.description && (
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.6,
                color: 'var(--text-dim)',
                whiteSpace: 'pre-wrap',
                textWrap: 'pretty',
                maxWidth: 860,
              }}
            >
              {story.description}
            </p>
          )}
          {(story.touchPoints?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-faint)',
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                }}
              >
                touches
              </span>
              {story.touchPoints!.map((tp) => (
                <code
                  key={tp}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--cyan, var(--text-dim))',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    padding: '1px 6px',
                  }}
                >
                  {tp}
                </code>
              ))}
            </div>
          )}
          {depLabels.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--text-faint)',
                  marginRight: 8,
                }}
              >
                after
              </span>
              {depLabels.join(' · ')}
            </div>
          )}
        </div>
      )}
      {expanded && hasCriteria && (
        <ul
          style={{
            listStyle: 'none',
            padding: '0 0 4px 24px',
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {criteria.map((c) => (
            <li
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: 'var(--text-dim)',
                lineHeight: 1.5,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-faint)',
                  letterSpacing: '0.08em',
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                {c.id}
              </span>
              <span style={{ flex: 1 }}>{c.text}</span>
              {c.needsBrowser && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    color: 'var(--accent-purple)',
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                  title="Requires browser/visual verification — will spawn a visual test"
                >
                  browser
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StoryDot({ status }: { status: string }) {
  const color =
    status === 'done'
      ? 'var(--success)'
      : status === 'running'
        ? 'var(--accent-purple)'
        : status === 'queued'
          ? 'var(--warning)'
          : status === 'failed' || status === 'blocked'
            ? 'var(--destructive)'
            : 'var(--text-faint)';
  return (
    <span
      style={{
        width: 6,
        height: 6,
        background: color,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-block',
      }}
      aria-label={status}
    />
  );
}

/**
 * PR-9 #2 — collapsible PM-agent log panel for the Concept stage.
 *
 * Surfaces the same stream-json trace the dev/reviewer stages already
 * expose, scoped to the PM job. Solves the "PM is not producing any
 * auditable logs" complaint — the trace was always captured by the
 * daemon (it's a regular agent-job with extractors) but the Concept
 * stage previously rendered just a "drafting…" spinner.
 */
function PmAgentLogPanel({ jobId, defaultOpen }: { jobId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SectionHeader>PM agent trace</SectionHeader>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-faint)',
              letterSpacing: '0.04em',
            }}
          >
            job {jobId.slice(0, 8)}
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.14em',
          }}
        >
          {open ? '▾ HIDE' : '▸ SHOW'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
          <StoryLiveOutput jobId={jobId} />
        </div>
      )}
    </section>
  );
}

/** The specialized BMAD persona behind each concept-stage agent job. */
const CONCEPT_PERSONA: Record<string, { name: string; role: string; icon: string; doc: string }> = {
  route: { name: 'Mary', role: 'Analyst', icon: '📊', doc: 'routing' },
  prd: { name: 'John', role: 'Product Manager', icon: '📋', doc: 'prd.md' },
  ux: { name: 'Sally', role: 'UX Expert', icon: '🎨', doc: 'ux-spec.md' },
  architecture: { name: 'Winston', role: 'Architect', icon: '🏗️', doc: 'architecture.md' },
};

interface ConceptAgentEntry {
  kind: string;
  jobId: string;
  status?: string;
}

/**
 * Persistent, collapsible per-agent trace panel for the whole concept stage.
 * Every agent that has run (Mary→John→Sally→Winston) keeps its own panel — the
 * active one auto-expands + streams live, finished ones stay collapsed so their
 * logs are never lost between docs. A "Download forensic log" button exports the
 * full multi-agent trace for later inspection.
 */
function ConceptAgentLogs({ plan, activeKind }: { plan: PlanWithEpics; activeKind?: string }) {
  const entries: ConceptAgentEntry[] = (
    [
      { kind: 'route', jobId: plan.conceptRouteJobId },
      { kind: 'prd', jobId: plan.conceptArtifactJobIds?.prd },
      { kind: 'ux', jobId: plan.conceptArtifactJobIds?.ux },
      { kind: 'architecture', jobId: plan.conceptArtifactJobIds?.architecture },
    ] as Array<{ kind: string; jobId?: string }>
  )
    .filter((e): e is ConceptAgentEntry => !!e.jobId)
    .map((e) => ({
      ...e,
      status: (plan.conceptArtifacts ?? []).find((a) => a.kind === e.kind)?.status,
    }));

  if (entries.length === 0) return null;

  async function downloadForensicLog() {
    const lines: string[] = [
      `# Concept-stage forensic log — ${plan.name}`,
      `# plan ${plan.planId}`,
      `# exported ${new Date().toISOString()}`,
      '',
    ];
    for (const e of entries) {
      const p = CONCEPT_PERSONA[e.kind] ?? { name: 'Agent', role: 'Specialist', doc: e.kind };
      lines.push(
        '',
        '================================================================',
        `## ${p.name} · ${p.role} — ${p.doc}  (job ${e.jobId.slice(0, 8)}, status ${e.status ?? 'n/a'})`,
        '================================================================',
        '',
      );
      try {
        const res = await api.get<{ events: AgentEvent[] }>(
          `/agent-jobs/${e.jobId}/events?limit=5000`,
        );
        for (const ev of res.events ?? []) {
          const ts = (ev as { timestamp?: string }).timestamp ?? '';
          if (ev.eventType === 'tool_use') {
            lines.push(
              `[${ts}] tool: ${ev.toolName ?? ''} ${ev.toolInput ? JSON.stringify(ev.toolInput) : ''}`,
            );
          } else if (ev.text) {
            lines.push(`[${ts}] ${ev.text}`);
          } else {
            lines.push(`[${ts}] (${ev.eventType})`);
          }
        }
      } catch {
        lines.push('  (failed to load events for this agent)');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${plan.name}-concept-forensic-log.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SectionHeader>Agent traces</SectionHeader>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {entries.length} agent{entries.length === 1 ? '' : 's'} · persistent
        </span>
        <button
          type="button"
          onClick={downloadForensicLog}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-mute)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          ⬇ Download forensic log
        </button>
      </div>
      {entries.map((e) => (
        <CollapsibleAgentLog key={e.kind} entry={e} defaultOpen={e.kind === activeKind} />
      ))}
    </section>
  );
}

/** One collapsible agent trace, headed by its persona; live-streams via StoryLiveOutput. */
function CollapsibleAgentLog({
  entry,
  defaultOpen,
}: {
  entry: ConceptAgentEntry;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  // Auto-collapse on handoff: when this agent stops being the active one (the
  // chain moved to the next persona) collapse it; when it becomes active, expand.
  // Syncs only when `defaultOpen` actually flips, so a manual toggle in between
  // is preserved until the next handoff.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(!!defaultOpen);
  }, [defaultOpen]);
  const p = CONCEPT_PERSONA[entry.kind] ?? {
    name: 'Agent',
    role: 'Specialist',
    icon: '✦',
    doc: entry.kind,
  };
  const live = !!defaultOpen; // the active (auto-opened) agent is the live one
  const statusLabel =
    entry.status === 'approved'
      ? '✓ approved'
      : entry.status === 'stale'
        ? '↻ stale'
        : live
          ? 'drafting…'
          : 'draft';
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
        }}
      >
        {live ? (
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-purple)' }} />
        ) : (
          <span style={{ fontSize: 15 }}>{p.icon}</span>
        )}
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {p.name}
          <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}> · {p.role}</span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.doc}</span>
        <span
          style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: entry.status === 'approved' ? 'var(--success)' : 'var(--accent-blue)',
          }}
        >
          {statusLabel}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
          }}
        >
          {open ? '▾ HIDE' : '▸ SHOW'} · job {entry.jobId.slice(0, 8)}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
          {/* Concept agents: logs + live thinking only — the document itself is
              read in the drawer (View), so the raw JSON Response dump is hidden. */}
          <StoryLiveOutput jobId={entry.jobId} hideResponse />
        </div>
      )}
    </section>
  );
}

function GeneratingBanner({ pmJobId }: { pmJobId?: string | null }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-2)',
        background: 'color-mix(in srgb, var(--accent-purple) 8%, transparent)',
        borderRadius: 8,
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <Loader2
        size={16}
        className="animate-spin"
        style={{ color: 'var(--accent-purple)', flexShrink: 0 }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            color: 'var(--foreground)',
            fontWeight: 500,
            marginBottom: 2,
          }}
        >
          PM agent is drafting your plan…
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.08em',
          }}
        >
          Epics and stories will appear as soon as the PM finishes.
          {pmJobId && (
            <>
              {' · '}
              <span style={{ color: 'var(--text-dim)' }}>job {pmJobId.slice(0, 8)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FailedBanner() {
  return (
    <div
      style={{
        border: '1px solid var(--destructive)',
        background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
        color: 'var(--destructive)',
        borderRadius: 8,
        padding: '14px 18px',
        fontSize: 13,
      }}
    >
      The PM agent failed to generate this plan. Click <strong>Regenerate</strong> to retry.
    </div>
  );
}

/**
 * Plan portability (2026-06-11) — JSON edit/import modal.
 *
 * One surface serves three flows: edit the current plan (prefilled from
 * export), import a saved export, or paste an external LLM's output (the
 * server strips ---PLAN_JSON--- fences and markdown code blocks, so raw
 * paste works). Validation is server-side — the same funnel the PM agent's
 * own output goes through (schema, references, touch-point hygiene, visual
 * coverage) — and errors render verbatim so the operator can fix the JSON
 * in place.
 */
function PlanJsonModal({
  mode,
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  mode: 'edit' | 'import';
  initial: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await onSubmit(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function loadFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  return (
    <>
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 80 }}
      />
      <div
        role="dialog"
        aria-label={mode === 'edit' ? 'Edit plan JSON' : 'Import plan JSON'}
        style={{
          position: 'fixed',
          top: '6vh',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(860px, 94vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elev, var(--background))',
          border: '1px solid var(--border)',
          borderRadius: 8,
          zIndex: 81,
          padding: 18,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionHeader>{mode === 'edit' ? 'Edit plan JSON' : 'Import plan JSON'}</SectionHeader>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label
              style={{
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                padding: '6px 14px',
                border: '1px solid var(--border-2)',
                borderRadius: 2,
                color: 'var(--text-dim)',
                cursor: 'pointer',
              }}
            >
              Load file…
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => loadFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <GhostButton label="Cancel" onClick={onCancel} disabled={pending} />
            <SolidButton
              label={pending ? 'Applying…' : 'Validate & apply'}
              onClick={submit}
              disabled={pending || text.trim().length === 0}
            />
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Paste a plan JSON (an export, a hand-edited plan, or an external LLM&apos;s output —
          fences and code blocks are tolerated). Applying <strong>replaces</strong> the current epic
          tree; waves are recomputed from <code>dependsOn</code> + <code>touchPoints</code>.
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 320,
            width: '100%',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '10px 12px',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--foreground)',
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
            outline: 'none',
          }}
          placeholder='{ "plan": { "name": "…", "description": "…", "epics": [ … ] } }'
        />
        {error && (
          <div
            style={{
              border: '1px solid var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
              color: 'var(--destructive)',
              borderRadius: 6,
              padding: '10px 12px',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 160,
              overflowY: 'auto',
            }}
          >
            {error}
          </div>
        )}
      </div>
    </>
  );
}

function EmptyCard({ children, faded }: { children: React.ReactNode; faded?: boolean }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '26px 20px',
        textAlign: 'center',
        color: faded ? 'var(--text-faint)' : 'var(--text-mute)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.22em',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function GhostButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '6px 14px',
        border: '1px solid var(--border-2)',
        borderRadius: 2,
        color: 'var(--text-dim)',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function SolidButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '6px 14px',
        border: '1px solid var(--foreground)',
        borderRadius: 2,
        color: 'var(--background)',
        background: 'var(--foreground)',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
