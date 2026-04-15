'use client';
import { Card, CardContent } from '@/components/ui/card';
import { useEpicList, type EpicSummary } from '@/hooks/use-epic-workflow';

interface ProjectSelectorProps {
  currentEpicId: string | null;
  onSelect: (epicId: string) => void;
  onNew: () => void;
}

function statusBadge(epic: EpicSummary) {
  if (epic.deployUrl || epic.status === 'deployed')
    return { label: 'Deployed', color: 'bg-blue-900 text-blue-400' };
  if (epic.status === 'completed')
    return { label: 'Completed', color: 'bg-green-900 text-green-400' };
  if (epic.status === 'in_review')
    return { label: 'In Review', color: 'bg-purple-900 text-purple-400' };
  if (epic.status === 'fixing') return { label: 'Fixing', color: 'bg-red-900 text-red-400' };
  if (epic.status === 'failed') return { label: 'Failed', color: 'bg-red-900 text-red-400' };
  if (
    epic.status === 'in_progress' ||
    (epic.doneStories > 0 && epic.doneStories < epic.totalStories)
  )
    return { label: 'In Progress', color: 'bg-yellow-900 text-yellow-400' };
  if (epic.status === 'ready' || epic.totalStories > 0)
    return { label: 'Ready', color: 'bg-muted text-muted-foreground' };
  return { label: 'Draft', color: 'bg-muted text-muted-foreground' };
}

export function ProjectSelector({ currentEpicId, onSelect, onNew }: ProjectSelectorProps) {
  const { data: epics, isLoading } = useEpicList();

  if (isLoading) return null;
  if (!epics || epics.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Your Projects
          </h3>
          <button
            onClick={onNew}
            className="rounded-md border border-input px-2.5 py-1 text-[10px] hover:bg-accent"
          >
            + New Project
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {epics.map((epic) => {
            const badge = statusBadge(epic);
            const isActive = epic.epicId === currentEpicId;
            const progress =
              epic.totalStories > 0 ? (epic.doneStories / epic.totalStories) * 100 : 0;

            return (
              <button
                key={epic.epicId}
                onClick={() => onSelect(epic.epicId)}
                className={`text-left rounded-md border p-3 transition-colors ${
                  isActive ? 'border-primary bg-primary/5' : 'border-input hover:bg-accent/30'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">
                      {epic.title?.replace(/^Epic:\s*/i, '') || epic.appName}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      {epic.appName}
                    </div>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] whitespace-nowrap ${badge.color}`}
                  >
                    {badge.label}
                  </span>
                </div>

                {epic.totalStories > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="text-[9px] text-muted-foreground">
                      {epic.doneStories}/{epic.totalStories} stories
                    </div>
                  </div>
                )}

                {epic.deployUrl && (
                  <div className="mt-1 text-[9px] text-blue-400 truncate">{epic.deployUrl}</div>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
