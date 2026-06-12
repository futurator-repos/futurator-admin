'use client';
import { useMemo, useRef, useState } from 'react';
import {
  useSession,
  useSessionEvents,
  useSendMessageMutation,
  useRenameSessionMutation,
} from '@/hooks/use-party-session';
import { useUploadPartyDoc } from '@/hooks/use-party-docs';
import { useSessionDraft } from '@/hooks/use-session-draft';
import { usePartyProject, useUpdatePartyProject } from '@/hooks/use-party-projects';
import { useAuthStore } from '@/stores/auth-store';
import { DEFAULT_ALLOWED_TOOLS } from '@/types/party';
import { adaptSession } from '../turn-adapter';
import { COLORS, PANE_DEFAULTS } from './tokens';
import { LeftPane } from './left-pane';
import { MainPane } from './main-pane';
import { RightRail } from './right-rail';
import { usePaneResize } from './use-pane-resize';
import { FileDrawerProvider } from './file-drawer';
import { SelectionPopover } from './selection-popover';
import { AuditDrawer } from './audit-drawer';

interface Props {
  sessionId: string;
  onClose: () => void;
  /** @deprecated Session navigation now lives at /debates — kept for API compat. */
  onPickSession?: (sessionId: string) => void;
  /** @deprecated Session navigation now lives at /debates — kept for API compat. */
  onNewSession?: () => void;
}

/**
 * V2 SessionChat — the new three-pane Discord/Slack/Linear-leaning UI.
 * Spec: `docs/concepts/party-mode/party-mode-ui2.md`.
 *
 * Wires the existing party-session/event hooks into the new layout. The
 * stream parser (turn-parser.ts) understands both the new ⟪AGENT:Name⟫
 * marker format AND the legacy `📋 **John:**` format for backwards compat.
 */
export function SessionChatV2({ sessionId, onClose }: Props) {
  const { data: session } = useSession(sessionId);
  const { events } = useSessionEvents(sessionId, session?.status);
  const sendMessage = useSendMessageMutation(sessionId);
  const renameSession = useRenameSessionMutation(sessionId);
  const uploadDoc = useUploadPartyDoc(session?.projectId ?? null, sessionId);
  const { data: project } = usePartyProject(session?.projectId ?? null);
  const updateProject = useUpdatePartyProject(session?.projectId ?? null);
  const authUser = useAuthStore((s) => s.user);
  // Draft persists to localStorage per session so an unexpected logout /
  // reload never costs the user an in-progress answer (see use-session-draft).
  const [draft, setDraft] = useSessionDraft(sessionId);

  const adapted = useMemo(() => adaptSession(events, session?.status), [events, session?.status]);
  const { rounds, isProcessing } = adapted;

  // Anchor-scroll target. The right rail's "round" buttons set this; the
  // main pane scrolls to the corresponding `[data-round-anchor]` element.
  // The continuous thread always shows ALL rounds — pinning never hides
  // earlier content (was the source of the "round 2 reset everything"
  // bug from the previous iteration).
  const [pinnedRoundId, setPinnedRoundId] = useState<string | null>(null);
  // Story 22.7 — audit drawer open state. The toggle lives in the right rail
  // footer; the drawer renders as a fullscreen portal over everything.
  const [auditOpen, setAuditOpen] = useState(false);

  const inflightRound = adapted.activeRoundId
    ? (rounds.find((r) => r.id === adapted.activeRoundId) ?? null)
    : null;
  // Show the cold-start skeleton inside the in-flight round only. We never
  // render skeletons in front of completed rounds, so the user's earlier
  // content stays visible while round N+1 spins up.
  const showSkeleton =
    (sendMessage.isPending && !inflightRound) ||
    (!!inflightRound && inflightRound.blocks.length === 0 && isProcessing);

  const isErrored = session?.status === 'ERROR';
  // DONE = published to main; the worktree is reaped and the lock can't be
  // re-acquired, so block sending and tell the user to start a new debate.
  const isDone = session?.status === 'DONE';
  const projectChannel = session?.projectId ?? 'session';
  const sessionTitle = session?.topic ?? '';

  // Build the user identity for the question banner. OAuth-loaded user
  // takes priority; fall back to "You" so the banner never says "U" when
  // auth hasn't hydrated yet (rare but happens on first mount).
  const userIdentity = useMemo(() => {
    const name = authUser?.name?.trim() || authUser?.email?.split('@')[0] || 'You';
    const initial =
      name === 'You'
        ? 'Y'
        : name
            .split(/\s+/)
            .slice(0, 2)
            .map((p) => p[0])
            .join('')
            .toUpperCase();
    return { name, initial, picture: authUser?.picture };
  }, [authUser]);

  async function handleSend() {
    const content = draft.trim();
    if (!content) return;

    // If the user just attached docs but didn't mention them, prepend a
    // [Attached: …] header so the agents reliably notice them on this turn.
    // We only do this when the doc filename isn't already referenced in the
    // user's text (case-insensitive substring match).
    const justUploaded = uploadStatus.filter((s) => s.state === 'done').map((s) => s.filename);
    const unreferenced = justUploaded.filter(
      (fn) => !content.toLowerCase().includes(fn.toLowerCase()),
    );
    const enriched =
      unreferenced.length > 0
        ? `[Attached: ${unreferenced.map((f) => `./docs/${f}`).join(', ')}]\n\n${content}`
        : content;
    if (new TextEncoder().encode(enriched).length > 8192) return;
    setDraft(''); // optimistic clear (also clears the persisted localStorage copy)
    setUploadStatus([]); // clear pinned upload chips on send
    try {
      await sendMessage.mutateAsync(enriched);
    } catch {
      // Send failed (surfaced via session.status → ERROR). Restore the user's
      // text so it isn't lost — re-persists to localStorage via setDraft.
      setDraft(content);
    }
    // Snap back to the just-created round so the user sees their question.
    setPinnedRoundId(null);
  }

  function handleRename(next: string | null) {
    if (!sessionId) return;
    renameSession.mutate(next);
  }

  /**
   * Toggle one tool on/off for the active project. Reads the current
   * effective allowedTools (defaulting to DEFAULT_ALLOWED_TOOLS for
   * legacy projects without the field), adds or removes `tool`, then
   * patches the project. Optimistic — UI flips immediately.
   */
  function handleToggleTool(tool: string, next: boolean) {
    if (!project) return;
    const current = project.allowedTools ?? Array.from(DEFAULT_ALLOWED_TOOLS);
    const set = new Set(current);
    if (next) set.add(tool);
    else set.delete(tool);
    updateProject.mutate({ allowedTools: Array.from(set) });
  }

  // Per-file upload status surface — pinned above the doc tray so users see
  // progress / errors without opening DevTools. Cleared after 6s on success.
  const [uploadStatus, setUploadStatus] = useState<
    { filename: string; state: 'uploading' | 'done' | 'error'; reason?: string }[]
  >([]);

  async function handleAttach(files: File[]) {
    console.log('[Party V2] handleAttach received', files.length, 'file(s)');
    // Replace previous pills (don't accumulate stale entries across uploads).
    setUploadStatus(files.map((f) => ({ filename: f.name, state: 'uploading' as const })));
    for (const file of files) {
      try {
        await uploadDoc.mutateAsync({ file, scope: 'session' });
        console.log('[Party V2] uploaded', file.name);
        setUploadStatus((prev) =>
          prev.map((s) => (s.filename === file.name ? { ...s, state: 'done' as const } : s)),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('[Party V2] doc upload failed:', file.name, err);
        setUploadStatus((prev) =>
          prev.map((s) =>
            s.filename === file.name ? { ...s, state: 'error' as const, reason } : s,
          ),
        );
      }
    }
    // Pills stay pinned until the user sends a message (cleared inside
    // handleSend). This keeps the "what to do next" hint visible.
  }

  const { leftWidth, rightWidth, dragging, startLeftDrag, startRightDrag } = usePaneResize();

  // Insert a `./.party-uploads/<file>` reference into the draft (used by the
  // right rail's uploaded-docs panel rows).
  function pickDocIntoDraft(filename: string) {
    const ref = `./.party-uploads/${filename}`;
    setDraft((d) =>
      d.includes(ref) ? d : d.length > 0 ? `${d.replace(/\s+$/, '')} ${ref} ` : `Read ${ref} and `,
    );
  }

  // Scope for the SelectionPopover — only selections inside this element
  // get the "Ask a question" affordance.
  const chatScopeRef = useRef<HTMLDivElement | null>(null);

  /**
   * Right-rail Question click → scroll the chat to the round + flash the
   * round's outline. Pure DOM manipulation (outline only) so React's render
   * cycle doesn't fight us. In-text snippet highlighting is a future
   * enhancement; the round-level flash is good enough for the MVP.
   */
  function jumpToAnchor(roundId: string) {
    setPinnedRoundId(roundId);
    // Wait one frame so MainPane finishes scrolling to the anchor.
    window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-round-anchor="${roundId}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = el.style.boxShadow;
      const prevTransition = el.style.transition;
      el.style.transition = 'box-shadow 0.25s ease';
      el.style.boxShadow = '0 0 0 2px rgba(99, 179, 237, 0.6)';
      window.setTimeout(() => {
        el.style.boxShadow = prev;
        el.style.transition = prevTransition;
      }, 1800);
    });
  }

  if (!session) {
    return (
      <div
        className="flex items-center justify-center py-8 text-[12px]"
        style={{ background: COLORS.bgContent, color: COLORS.textMuted }}
      >
        Loading session…
      </div>
    );
  }

  return (
    <FileDrawerProvider projectId={session.projectId ?? null} sessionId={sessionId}>
      <div
        className="flex h-full overflow-hidden"
        style={{ background: COLORS.bgDeepest, color: COLORS.textPrimary }}
        data-testid="session-chat-v2"
      >
        <aside style={{ width: leftWidth, minWidth: PANE_DEFAULTS.leftMin }}>
          <LeftPane
            rounds={rounds}
            activeRoundId={pinnedRoundId ?? adapted.activeRoundId}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => void handleSend()}
            isProcessing={isProcessing || sendMessage.isPending}
            isErrored={isErrored}
            isDone={isDone}
            onAttach={handleAttach}
            isUploading={uploadDoc.isPending}
            acceptedTypes=".md,.markdown,.txt,.pdf,.json,.csv,.yml,.yaml,application/pdf,text/plain,text/markdown,application/json,text/csv,text/yaml"
            uploadStatus={uploadStatus}
          />
        </aside>

        <div
          className="party-resize-handle"
          data-dragging={dragging === 'left' ? 'true' : 'false'}
          onMouseDown={startLeftDrag}
          role="separator"
          aria-orientation="vertical"
        />

        <main className="flex flex-1 flex-col" style={{ minWidth: 0 }}>
          <div
            ref={chatScopeRef}
            data-party-chat-content
            className="flex-1"
            style={{ minHeight: 0 }}
          >
            <MainPane
              title={sessionTitle}
              channel={projectChannel}
              rounds={rounds}
              pinnedRoundId={pinnedRoundId}
              showSkeleton={showSkeleton}
              user={userIdentity}
              allowedTools={project?.allowedTools}
              onToggleTool={handleToggleTool}
              onClose={onClose}
              onRename={handleRename}
              sessionId={sessionId}
              projectId={project?.projectId}
              pushEnabled={project?.pushEnabled === true}
            />
          </div>
        </main>

        <div
          className="party-resize-handle"
          data-dragging={dragging === 'right' ? 'true' : 'false'}
          onMouseDown={startRightDrag}
          role="separator"
          aria-orientation="vertical"
        />

        {/* No minWidth here — the rail collapses to just its icon strip when
            the user toggles the active panel off. */}
        <aside className="flex shrink-0">
          <RightRail
            rounds={rounds}
            activeRoundId={pinnedRoundId ?? adapted.activeRoundId}
            onSelectRound={(id) => setPinnedRoundId(id)}
            events={events}
            onJumpToRound={(n) => jumpToAnchor(`r-${n + 1}`)}
            onJumpToAnchor={jumpToAnchor}
            sessionId={sessionId}
            projectId={session.projectId ?? null}
            onPickDoc={pickDocIntoDraft}
            onAttach={handleAttach}
            onOpenAudit={() => setAuditOpen(true)}
            panelWidth={rightWidth}
          />
        </aside>

        <AuditDrawer sessionId={sessionId} open={auditOpen} onClose={() => setAuditOpen(false)} />

        {/* Floating mini-panel triggered by text selection inside the chat. */}
        <SelectionPopover sessionId={sessionId} scopeRef={chatScopeRef} />
      </div>
    </FileDrawerProvider>
  );
}
