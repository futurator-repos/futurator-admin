'use client';
import { useMemo, useRef, useState } from 'react';
import {
  useSession,
  useSessionEvents,
  useSendMessageMutation,
  useRenameSessionMutation,
} from '@/hooks/use-party-session';
import { useUploadPartyDoc } from '@/hooks/use-party-docs';
import { useSessionsForProject } from '@/hooks/use-party-sessions';
import { usePartyProject, useUpdatePartyProject } from '@/hooks/use-party-projects';
import { useAuthStore } from '@/stores/auth-store';
import { DEFAULT_ALLOWED_TOOLS } from '@/types/party';
import { adaptSession } from '../turn-adapter';
import { COLORS, PANE_DEFAULTS } from './tokens';
import { LeftPane, type LeftPaneSession } from './left-pane';
import { MainPane } from './main-pane';
import { RoundRail } from './round-rail';
import { usePaneResize } from './use-pane-resize';
import { DocTray } from '../doc-tray';
import { FileDrawerProvider } from './file-drawer';
import { SelectionPopover } from './selection-popover';
import { InlineQuestionsList } from './inline-questions-list';
import { AgentQuestionsCard } from './agent-questions-card';
import { AuditDrawer } from './audit-drawer';

interface Props {
  sessionId: string;
  onClose: () => void;
  onPickSession?: (sessionId: string) => void;
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
export function SessionChatV2({ sessionId, onClose, onPickSession, onNewSession }: Props) {
  const { data: session } = useSession(sessionId);
  const { events } = useSessionEvents(sessionId, session?.status);
  const sendMessage = useSendMessageMutation(sessionId);
  const renameSession = useRenameSessionMutation(sessionId);
  const uploadDoc = useUploadPartyDoc(session?.projectId ?? null);
  const { data: sessionsList } = useSessionsForProject(session?.projectId ?? null);
  const { data: project } = usePartyProject(session?.projectId ?? null);
  const updateProject = useUpdatePartyProject(session?.projectId ?? null);
  const authUser = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState('');

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
    setDraft('');
    setUploadStatus([]); // clear pinned upload chips on send
    try {
      await sendMessage.mutateAsync(enriched);
    } catch {
      /* surfaced via session.status flipping to ERROR */
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
        await uploadDoc.mutateAsync(file);
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

  const sessionsForLeft: LeftPaneSession[] = (sessionsList?.sessions ?? []).map((s) => ({
    sessionId: s.sessionId,
    topic: s.topic,
    status: s.status,
    turnCount: s.turnCount,
    lastTurnAt: s.lastTurnAt,
    createdAt: s.createdAt,
  }));

  const { leftWidth, rightWidth, dragging, startLeftDrag, startRightDrag } = usePaneResize();

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
    <FileDrawerProvider projectId={session.projectId ?? null}>
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
            onAttach={handleAttach}
            isUploading={uploadDoc.isPending}
            acceptedTypes=".md,.markdown,.txt,.pdf,.json,.csv,.yml,.yaml,application/pdf,text/plain,text/markdown,application/json,text/csv,text/yaml"
            sessions={sessionsForLeft}
            activeSessionId={sessionId}
            onPickSession={onPickSession}
            onNewSession={onNewSession}
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
          {/* Doc tray + upload-status surface — kept above the main scroller so
            users see what they just attached, what's in flight, and any
            error reasons without opening DevTools. */}
          {session.projectId && (
            <div
              className="px-5 py-2 space-y-1.5"
              style={{
                background: COLORS.bgContent,
                borderBottom: `1px solid ${COLORS.bgDeepest}`,
              }}
            >
              {uploadStatus.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {uploadStatus.map((s) => {
                      const tone =
                        s.state === 'uploading'
                          ? 'border-blue-400/30 bg-blue-500/15 text-blue-300'
                          : s.state === 'done'
                            ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                            : 'border-red-400/30 bg-red-500/15 text-red-300';
                      return (
                        <span
                          key={s.filename}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-mono ${tone}`}
                          title={s.reason}
                        >
                          {s.state === 'uploading' && '⏳'}
                          {s.state === 'done' && '✓'}
                          {s.state === 'error' && '✕'}
                          <span className="max-w-[220px] truncate">{s.filename}</span>
                          {s.state === 'error' && s.reason && (
                            <span className="opacity-80 truncate max-w-[220px]">— {s.reason}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  {uploadStatus.some((s) => s.state === 'done') && (
                    <div className="flex items-start gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/5 px-2.5 py-1.5 text-[11px] text-emerald-200/90">
                      <span aria-hidden>📄</span>
                      <span>
                        Uploaded. Type a follow-up message and click <strong>Send</strong> — the
                        agents will read{' '}
                        {uploadStatus
                          .filter((s) => s.state === 'done')
                          .map((s) => (
                            <code
                              key={s.filename}
                              className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10.5px] font-mono"
                            >
                              ./docs/{s.filename}
                            </code>
                          ))
                          .reduce<React.ReactNode[]>(
                            (acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]),
                            [],
                          )}{' '}
                        on the next turn. (We&rsquo;ll auto-add an{' '}
                        <code className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10.5px] font-mono">
                          [Attached: …]
                        </code>{' '}
                        header to your message if you don&rsquo;t mention the file by name.)
                      </span>
                    </div>
                  )}
                </div>
              )}
              <DocTray
                projectId={session.projectId}
                onPickDoc={(filename) => {
                  const ref = `./docs/${filename}`;
                  setDraft((d) =>
                    d.includes(ref)
                      ? d
                      : d.length > 0
                        ? `${d.replace(/\s+$/, '')} ${ref} `
                        : `Read ${ref} and `,
                  );
                }}
              />
            </div>
          )}
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

        <aside
          className="flex flex-col overflow-y-auto"
          style={{ width: rightWidth, minWidth: PANE_DEFAULTS.rightMin }}
        >
          <div className="shrink-0">
            <RoundRail
              rounds={rounds}
              activeRoundId={pinnedRoundId ?? adapted.activeRoundId}
              onSelect={(id) => setPinnedRoundId(id)}
            />
          </div>
          <AgentQuestionsCard events={events} onJumpToRound={(n) => jumpToAnchor(`r-${n + 1}`)} />
          <InlineQuestionsList sessionId={sessionId} onJumpTo={jumpToAnchor} />
          <div className="mt-auto shrink-0 px-3 py-2">
            <button
              type="button"
              onClick={() => setAuditOpen(true)}
              className="party-hover-tint w-full rounded-md border px-2 py-1.5 text-[11px]"
              style={{ borderColor: 'var(--party-bg-deepest)', color: 'var(--party-text-muted)' }}
              data-testid="open-audit-drawer"
              title="Show all checkpoint, ASK_HUMAN, and tool default-allow events for this session"
            >
              Audit log
            </button>
          </div>
        </aside>

        <AuditDrawer sessionId={sessionId} open={auditOpen} onClose={() => setAuditOpen(false)} />

        {/* Floating mini-panel triggered by text selection inside the chat. */}
        <SelectionPopover sessionId={sessionId} scopeRef={chatScopeRef} />
      </div>
    </FileDrawerProvider>
  );
}
