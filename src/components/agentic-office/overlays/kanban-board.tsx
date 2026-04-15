'use client';
import { useOfficeStore } from '@/stores/office-store';
import type { KanbanColumn, KanbanStory } from '@/types/agentic-office';

const COLUMNS: { key: KanbanColumn; label: string; color: string }[] = [
  { key: 'backlog', label: 'Backlog', color: '#666' },
  { key: 'in_progress', label: 'In Progress', color: '#4a90d9' },
  { key: 'in_review', label: 'In Review', color: '#d9a04a' },
  { key: 'fixing', label: 'Fixing', color: '#d94a6a' },
  { key: 'done', label: 'Done', color: '#4ad996' },
];

// Color palette for epics — hue-based
const EPIC_COLORS = [
  '#4a90d9',
  '#d94a6a',
  '#5ab88a',
  '#d9a04a',
  '#8a5ad9',
  '#d95a4a',
  '#4ad9d9',
  '#9ad94a',
  '#d94ad9',
  '#6a8ad9',
];

function epicColor(epicId: string, allEpicIds: string[]): string {
  const idx = allEpicIds.indexOf(epicId);
  return EPIC_COLORS[idx >= 0 ? idx % EPIC_COLORS.length : 0];
}

function PostIt({ story, color }: { story: KanbanStory; color: string }) {
  return (
    <div
      className="mb-1.5 rounded px-2 py-1.5 text-[10px] leading-tight shadow-sm transition-all"
      style={{
        background: `${color}20`,
        borderLeft: `3px solid ${color}`,
        borderTop: story.failed ? '2px solid #d94a6a' : 'none',
      }}
    >
      <div className="mb-0.5 font-semibold text-white/90" style={{ fontSize: 10 }}>
        {story.title.length > 35 ? story.title.slice(0, 32) + '...' : story.title}
      </div>
      <div className="flex items-center gap-1.5 text-white/50" style={{ fontSize: 9 }}>
        {story.wave !== null && (
          <span className="rounded bg-white/10 px-1 py-px">W{story.wave}</span>
        )}
        {story.workerName && <span style={{ color }}>{story.workerName}</span>}
        {story.failed && <span className="text-red-400">Failed</span>}
      </div>
    </div>
  );
}

export function KanbanBoard() {
  const isOpen = useOfficeStore((s) => s.kanbanOpen);
  const setIsOpen = useOfficeStore((s) => s.setKanbanOpen);
  const kanbanStories = useOfficeStore((s) => s.kanbanStories);
  const activeEpicIds = useOfficeStore((s) => s.activeEpicIds);
  const selectedEpicId = useOfficeStore((s) => s.selectedKanbanEpicId);
  const selectKanbanEpic = useOfficeStore((s) => s.selectKanbanEpic);

  // Get unique epic IDs from stories
  const epicIds = [...new Set(kanbanStories.map((s) => s.epicId))];
  const epicTitles = new Map<string, string>();
  for (const s of kanbanStories) {
    if (!epicTitles.has(s.epicId)) epicTitles.set(s.epicId, s.epicTitle);
  }

  const filtered = selectedEpicId
    ? kanbanStories.filter((s) => s.epicId === selectedEpicId)
    : kanbanStories;

  if (!kanbanStories.length && !isOpen) return null;

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="absolute right-4 top-14 z-20 rounded-md border border-white/10 bg-[#12122a] px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/60 transition hover:bg-white/5 hover:text-white/80"
      >
        {isOpen ? '✕ Close' : '📋 Kanban'}
        {!isOpen && kanbanStories.length > 0 && (
          <span className="ml-1.5 rounded bg-blue-500/20 px-1 py-px text-blue-400">
            {kanbanStories.length}
          </span>
        )}
      </button>

      {/* Board */}
      {isOpen && (
        <div className="absolute inset-x-4 bottom-4 top-24 z-20 flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#12122aee] backdrop-blur-sm">
          {/* Header with epic tabs */}
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Kanban Board</span>
            <div className="ml-4 flex gap-1.5">
              <button
                onClick={() => selectKanbanEpic(null)}
                className="rounded px-2 py-0.5 text-[10px] transition"
                style={{
                  background: !selectedEpicId ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: !selectedEpicId ? '#fff' : '#666',
                }}
              >
                All
              </button>
              {epicIds.map((id) => (
                <button
                  key={id}
                  onClick={() => selectKanbanEpic(id === selectedEpicId ? null : id)}
                  className="rounded px-2 py-0.5 text-[10px] transition"
                  style={{
                    background:
                      selectedEpicId === id ? `${epicColor(id, activeEpicIds)}30` : 'transparent',
                    color: selectedEpicId === id ? epicColor(id, activeEpicIds) : '#666',
                    borderBottom:
                      selectedEpicId === id ? `2px solid ${epicColor(id, activeEpicIds)}` : 'none',
                  }}
                >
                  {(epicTitles.get(id) ?? id).slice(0, 20)}
                </button>
              ))}
            </div>
          </div>

          {/* Columns */}
          <div className="flex flex-1 gap-2 overflow-x-auto p-3">
            {COLUMNS.map((col) => {
              const stories = filtered.filter((s) => s.column === col.key);
              return (
                <div key={col.key} className="flex min-w-[160px] flex-1 flex-col">
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <div className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
                    <span
                      className="text-[10px] uppercase tracking-wider"
                      style={{ color: col.color }}
                    >
                      {col.label}
                    </span>
                    <span className="ml-auto text-[9px] text-white/30">{stories.length}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto rounded bg-white/[0.03] p-1.5">
                    {stories.map((s) => (
                      <PostIt
                        key={`${s.epicId}-${s.storyId}`}
                        story={s}
                        color={epicColor(s.epicId, activeEpicIds)}
                      />
                    ))}
                    {stories.length === 0 && (
                      <div className="py-4 text-center text-[9px] text-white/20">Empty</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
