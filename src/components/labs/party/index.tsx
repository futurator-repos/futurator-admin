'use client';
import { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SessionChatV2 } from './v2/session-chat-v2';
import { BootstrapProgress } from './bootstrap-progress';
import { ProjectStatusBadge } from './project-status-badge';
import { WelcomeEmpty } from './welcome-empty';
import { usePartyStore } from '@/stores/party-store';
import { useLabsStore, normalizeAppName } from '@/stores/labs-store';
import {
  usePartyProjects,
  useBootstrapMutation,
  useInspectMutation,
} from '@/hooks/use-party-projects';
import {
  useCreateSessionMutation,
  useSessionsForProject,
} from '@/hooks/use-party-sessions';
import { useCreatePartyProject } from '@/hooks/use-party-docs';
import type { PartyProject, PartySession } from '@/types/party';

interface PartyProps {
  /**
   * When set, the Party view is locked to this project and the top-level
   * "Switch project" / chooser affordances are hidden. Used by the Plan
   * dashboard's Party Mode stage to scope the whole chat to a specific plan.
   */
  projectIdOverride?: string;
}

export function Party({ projectIdOverride }: PartyProps = {}) {
  const { activeAppName: storeAppName, setActiveAppName } = useLabsStore();
  const activeAppName = projectIdOverride ?? storeAppName;
  const isScoped = !!projectIdOverride;
  const activeSessionId = usePartyStore((s) => s.activeSessionId);
  const closeSession = usePartyStore((s) => s.closeSession);
  const openSession = usePartyStore((s) => s.openSession);
  const selectProject = usePartyStore((s) => s.selectProject);
  const { data } = usePartyProjects();
  const bootstrap = useBootstrapMutation();
  const inspect = useInspectMutation();
  const createSession = useCreateSessionMutation();
  const createProject = useCreatePartyProject();

  const projects = useMemo(() => data?.projects || [], [data?.projects]);
  const project = projects.find((p) => p.projectId === activeAppName) || null;

  // Auto-select when exactly one project exists and none is active. Skip when
  // scoped — the plan dashboard owns selection in that mode.
  useEffect(() => {
    if (isScoped) return;
    if (!storeAppName && projects.length === 1) {
      setActiveAppName(projects[0].projectId);
    }
  }, [isScoped, storeAppName, projects, setActiveAppName]);

  useEffect(() => {
    if (activeSessionId && (!project || project.bmadStatus !== 'HEALTHY')) {
      closeSession();
    }
  }, [activeAppName, project, activeSessionId, closeSession]);

  // When the scope changes (e.g. user navigates to another App's Party tab),
  // re-anchor the party store to the new project. selectProject also clears
  // any leftover activeSessionId so a session opened against App A doesn't
  // accidentally render against App B's chat shell.
  //
  // BUT — only if the store's selectedProjectId is actually stale. The Debates
  // page sets `selectedProjectId` + `activeSessionId` *before* navigating here,
  // and we don't want to clobber that hand-off. If the store already matches
  // our scope, leave activeSessionId alone.
  const selectedProjectId = usePartyStore((s) => s.selectedProjectId);
  useEffect(() => {
    if (!isScoped) return;
    if (selectedProjectId === activeAppName) return;
    selectProject(activeAppName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScoped, activeAppName, selectedProjectId]);

  // Bootstrap job to show progress for — two sources: the just-enqueued
  // bootstrap from this tab, or a job enqueued by the "Create project" flow
  // (which lands in the party-projects row as `lastBootstrapJobId` via the
  // lock acquisition step). The second path is how BMAD-CANON shows live
  // install progress right after creation.
  const latestBootstrapJobId =
    bootstrap.data?.jobId ||
    createProject.data?.jobId ||
    (project && project.bmadStatus !== 'HEALTHY' ? project.lastBootstrapJobId : null) ||
    null;

  async function handleStartSession() {
    if (!project || project.bmadStatus !== 'HEALTHY') return;
    const session = await createSession.mutateAsync({ projectId: project.projectId });
    selectProject(project.projectId);
    openSession(session.sessionId);
  }

  if (!activeAppName) {
    if (isScoped) {
      return (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
          Loading project…
        </div>
      );
    }
    return (
      <PartyProjectChooser
        projects={projects}
        onSelect={(id) => setActiveAppName(id)}
        onCreate={async (name) => {
          const result = await createProject.mutateAsync(name);
          setActiveAppName(result.projectId);
        }}
        creating={createProject.isPending}
      />
    );
  }

  // Session active → show V2 three-pane chat full-width
  if (activeSessionId) {
    return (
      <div
        className="min-h-[640px] h-[calc(100vh-220px)] overflow-hidden rounded-md border border-border"
        data-testid="labs-party"
      >
        <SessionChatV2
          sessionId={activeSessionId}
          onClose={closeSession}
          onPickSession={(id) => openSession(id)}
          onNewSession={() => void handleStartSession()}
        />
      </div>
    );
  }

  // No session but project is HEALTHY → show welcome/empty state
  if (project?.bmadStatus === 'HEALTHY') {
    return (
      <div
        className="rounded-lg border border-border bg-background min-h-[560px] flex flex-col"
        data-testid="labs-party"
      >
        <div className="border-b border-border px-5 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            {!isScoped ? (
              <button
                type="button"
                onClick={() => setActiveAppName(null)}
                className="rounded px-1.5 py-0.5 text-[11px] hover:bg-white/[0.04] hover:text-foreground"
                title="Switch project"
              >
                ← {project.projectId}
              </button>
            ) : (
              <span className="text-[11px] font-semibold text-foreground">
                {project.projectId}
              </span>
            )}
            <span className="font-mono">{project.path}</span>
            {project.bmadVersion && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0 text-[10.5px] font-mono">
                bmad {project.bmadVersion}
              </span>
            )}
            {typeof project.agentCount === 'number' && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0 text-[10.5px] font-mono">
                {project.agentCount}/{project.expectedAgentCount} agents
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={inspect.isPending}
              onClick={() => inspect.mutate(project.projectId)}
            >
              {inspect.isPending ? 'Inspecting…' : 'Re-inspect'}
            </Button>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={createSession.isPending}
              onClick={() => void handleStartSession()}
            >
              {createSession.isPending ? 'Starting…' : 'New Party'}
            </Button>
          </div>
        </div>
        <SessionHistory
          projectId={project.projectId}
          onOpen={(sessionId) => {
            selectProject(project.projectId);
            openSession(sessionId);
          }}
        />
        <WelcomeEmpty
          rosterSize={project.agentCount ?? project.expectedAgentCount}
          onPick={() => void handleStartSession()}
          disabled={createSession.isPending}
        />
      </div>
    );
  }

  // Otherwise — installing, missing, failed, drifted — show the BMAD panel
  return (
    <div
      className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 min-h-[440px]"
      data-testid="labs-party"
    >
      <div className="space-y-3">
        {!isScoped && (
          <button
            type="button"
            onClick={() => setActiveAppName(null)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Switch project
          </button>
        )}
        <ProjectPanel
          appName={activeAppName}
          project={project}
          expectedAgentCount={data?.expectedAgentCount ?? 14}
          onInstall={() => bootstrap.mutate({ projectId: activeAppName })}
          onReinspect={() => inspect.mutate(activeAppName)}
          installing={bootstrap.isPending}
          inspecting={inspect.isPending}
        />
      </div>
      <div className="space-y-3">
        {latestBootstrapJobId ? (
          <BootstrapProgress jobId={latestBootstrapJobId} />
        ) : (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            {project
              ? 'Install BMAD on this project to enable party sessions.'
              : 'This project is not on the daemon yet. Click "Install BMAD" to provision it.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Session history — list prior sessions for this project ──
// All sessions are persisted in DDB (futurator-party-sessions) with
// sessionId + claudeSessionId so they can be resumed at any time.
// Clicking a row opens it in SessionChat which hydrates from the
// per-session event stream; sending a new message on an ACTIVE/IDLE
// session uses Claude's --resume with the stored claudeSessionId.

const STATUS_TONE: Record<PartySession['status'], string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  PROCESSING: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  IDLE: 'bg-slate-500/15 text-slate-300 border-slate-400/30',
  ERROR: 'bg-red-500/15 text-red-300 border-red-400/30',
  ARCHIVED: 'bg-zinc-500/15 text-zinc-400 border-zinc-400/30',
};

function SessionHistory({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (sessionId: string) => void;
}) {
  const { data, isLoading } = useSessionsForProject(projectId);
  const sessions = useMemo(() => {
    const list = data?.sessions ?? [];
    // Server returns newest-first via GSI1; slice to a sensible max so the
    // welcome state stays scannable.
    return list.slice(0, 10);
  }, [data]);

  if (isLoading) {
    return (
      <div className="border-b border-border px-5 py-3 text-[11px] italic text-muted-foreground">
        Loading session history…
      </div>
    );
  }
  if (sessions.length === 0) return null;

  return (
    <div className="border-b border-border px-5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
          Recent sessions ({sessions.length})
        </div>
        <div className="text-[10px] text-muted-foreground">
          Click to resume — all chats persist across sessions
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sessions.map((s) => {
          const tone = STATUS_TONE[s.status] ?? STATUS_TONE.IDLE;
          const when = s.lastTurnAt ?? s.createdAt;
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => onOpen(s.sessionId)}
              className="group flex items-start gap-2 rounded-md border border-border bg-muted/10 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">
                  {s.topic || 'Untitled session'}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{s.turnCount} turn{s.turnCount === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{formatDistanceToNow(new Date(when))} ago</span>
                  <span className="truncate font-mono opacity-60">
                    {s.sessionId.slice(0, 8)}
                  </span>
                </div>
              </div>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${tone}`}
              >
                {s.status}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ChooserProps {
  projects: PartyProject[];
  onSelect: (projectId: string) => void;
  onCreate: (name: string) => Promise<void>;
  creating: boolean;
}

function PartyProjectChooser({ projects, onSelect, onCreate, creating }: ChooserProps) {
  const [newName, setNewName] = useState('bmad-canon');
  const normalized = normalizeAppName(newName);
  const canCreate = !!normalized && !creating;

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold">Party projects</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A Party project is a folder on EC2 with BMAD installed. Each has its own
          roster, session history, and doc tray.
        </p>
      </div>

      {projects.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
            Existing
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {projects.map((p) => (
              <button
                key={p.projectId}
                type="button"
                onClick={() => onSelect(p.projectId)}
                className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    p.bmadStatus === 'HEALTHY'
                      ? 'bg-green-500'
                      : p.bmadStatus === 'INSTALLING'
                        ? 'bg-blue-400 animate-pulse'
                        : 'bg-muted-foreground/40'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{p.projectId}</div>
                  <div className="text-[10.5px] text-muted-foreground truncate">
                    {p.bmadStatus}
                    {p.agentCount != null && ` · ${p.agentCount} agents`}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-4">
        <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
          New project
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="bmad-canon"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            disabled={!canCreate}
            onClick={() => {
              void onCreate(normalized);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
        <p className="text-[10.5px] text-muted-foreground">
          Creates the folder on EC2, installs BMAD 6.3.x, and injects the 8 custom
          agents (Ludwig, Pedrock, Sue Render, Rick &amp; co.).
        </p>
      </div>
    </div>
  );
}

interface PanelProps {
  appName: string;
  project: PartyProject | null;
  expectedAgentCount: number;
  onInstall: () => void;
  onReinspect: () => void;
  installing: boolean;
  inspecting: boolean;
}

function ProjectPanel({
  appName,
  project,
  expectedAgentCount,
  onInstall,
  onReinspect,
  installing,
  inspecting,
}: PanelProps) {
  return (
    <div className="rounded-md border border-border bg-card p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{appName}</div>
          <div className="text-[10.5px] text-muted-foreground font-mono truncate">
            {project?.path || `/home/ubuntu/projects/${appName}`}
          </div>
        </div>
        {project && (
          <ProjectStatusBadge status={project.bmadStatus} title={project.failureReason} />
        )}
      </div>

      {project && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          {project.bmadVersion && (
            <div>
              bmad <span className="font-mono">{project.bmadVersion}</span>
              {typeof project.agentCount === 'number' && (
                <>
                  {' '}
                  · <span className="font-mono">{project.agentCount}</span>/
                  <span className="font-mono">{expectedAgentCount}</span> agents
                </>
              )}
            </div>
          )}
          {project.lastInspectedAt && (
            <div>inspected {formatDistanceToNow(new Date(project.lastInspectedAt))} ago</div>
          )}
          {project.bmadStatus === 'FAILED' && project.failureReason && (
            <div className="text-red-400 truncate" title={project.failureReason}>
              {project.failureReason}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!project && (
          <span className="text-[11px] text-muted-foreground">
            Unknown to daemon. Create the folder or re-inspect.
          </span>
        )}
        {project &&
          (project.bmadStatus === 'MISSING' ||
            project.bmadStatus === 'FAILED' ||
            project.bmadStatus === 'CORRUPTED') && (
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={installing}
              onClick={onInstall}
            >
              {installing ? 'Installing…' : 'Install BMAD'}
            </Button>
          )}
        {project?.bmadStatus === 'DRIFTED' && (
          <Button size="sm" className="h-7 text-[11px]" disabled={installing} onClick={onInstall}>
            Re-sync agents
          </Button>
        )}
        {project?.bmadStatus === 'INSTALLING' && (
          <span className="text-[11px] text-blue-400">Installing BMAD…</span>
        )}
        {project?.bmadStatus && project.bmadStatus !== 'INSTALLING' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={inspecting}
            onClick={onReinspect}
          >
            {inspecting ? 'Inspecting…' : 'Re-inspect'}
          </Button>
        )}
      </div>
    </div>
  );
}
