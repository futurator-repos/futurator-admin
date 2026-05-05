'use client';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProjectStatusBadge } from './project-status-badge';
import {
  usePartyProjects,
  useBootstrapMutation,
  useInspectMutation,
} from '@/hooks/use-party-projects';
import { useCreateSessionMutation } from '@/hooks/use-party-sessions';
import { usePartyStore } from '@/stores/party-store';
import type { PartyProject } from '@/types/party';

export function ProjectList() {
  const { data, isLoading, error } = usePartyProjects();
  const bootstrap = useBootstrapMutation();
  const inspect = useInspectMutation();
  const createSession = useCreateSessionMutation();
  const selectProject = usePartyStore((s) => s.selectProject);
  const openSession = usePartyStore((s) => s.openSession);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Loading projects…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-red-400">Failed to load projects: {error.message}</p>
        </CardContent>
      </Card>
    );
  }

  const projects = data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">
            No projects discovered yet. Trigger inspection to populate the list, or create a folder
            under <code className="font-mono">/home/ubuntu/projects/</code> and refresh.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function handleStartParty(project: PartyProject) {
    if (project.bmadStatus !== 'HEALTHY') return;
    const session = await createSession.mutateAsync({ projectId: project.projectId });
    selectProject(project.projectId);
    openSession(session.sessionId);
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Projects ({projects.length})
          </h3>
          <span className="text-[10px] text-muted-foreground">
            expected agents: {data?.expectedAgentCount ?? 23}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {projects.map((project) => (
            <div
              key={project.projectId}
              data-testid={`party-project-${project.projectId}`}
              className="rounded-md border border-input p-3 hover:bg-accent/20 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{project.projectId}</div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">
                    {project.path}
                  </div>
                </div>
                <ProjectStatusBadge status={project.bmadStatus} title={project.failureReason} />
              </div>

              <div className="mt-2 text-[10px] text-muted-foreground space-y-0.5">
                {project.bmadVersion && (
                  <div>
                    bmad <span className="font-mono">{project.bmadVersion}</span>
                    {typeof project.agentCount === 'number' && (
                      <>
                        {' '}
                        · <span className="font-mono">{project.agentCount}</span> agents
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

              <div className="mt-3 flex items-center gap-2">
                {project.bmadStatus === 'MISSING' ||
                project.bmadStatus === 'FAILED' ||
                project.bmadStatus === 'CORRUPTED' ? (
                  <Button
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={bootstrap.isPending}
                    onClick={() => bootstrap.mutate({ projectId: project.projectId })}
                  >
                    Install BMAD
                  </Button>
                ) : null}
                {project.bmadStatus === 'HEALTHY' && (
                  <>
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      disabled={createSession.isPending}
                      onClick={() => handleStartParty(project)}
                    >
                      New Party
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      disabled={inspect.isPending}
                      onClick={() => inspect.mutate(project.projectId)}
                    >
                      Re-inspect
                    </Button>
                  </>
                )}
                {project.bmadStatus === 'DRIFTED' && (
                  <>
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      disabled={bootstrap.isPending}
                      onClick={() => bootstrap.mutate({ projectId: project.projectId })}
                    >
                      Re-sync agents
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => handleStartParty(project)}
                    >
                      Start anyway
                    </Button>
                  </>
                )}
                {project.bmadStatus === 'INSTALLING' && (
                  <span className="text-[10px] text-blue-400">Installing BMAD…</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
