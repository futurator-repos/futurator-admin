'use client';
import { useState, useCallback, useEffect, useMemo, createContext, useContext } from 'react';
import { useSearchParams } from 'next/navigation';
import { Trash2, X } from 'lucide-react';
import { useEc2Files, useDeleteEc2Folder, type FileEntry } from '@/hooks/use-ec2-files';
import { useServers, heartbeatState } from '@/hooks/use-servers';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { FileViewer, type OpenTab } from './file-viewer';

// Lifted tab state — DirectoryNode/FileNode are deeply nested so a context is
// cleaner than threading callbacks through every level of the tree.
interface TabsCtx {
  activePath: string | null;
  openFile: (path: string, name: string) => void;
}
const TabsContext = createContext<TabsCtx>({ activePath: null, openFile: () => {} });

// Mirror the backend allow-list so the trash icon only appears on folders the
// API will actually accept (matches PROJECT_FOLDER_RE and CLAUDE_SESSION_RE in
// functions/api/index.ts).
type DeletableKind = 'project' | 'claude-session';

function deletableKind(path: string): DeletableKind | null {
  if (/^\/home\/ubuntu\/projects\/[\w.\-]+$/.test(path)) return 'project';
  if (/^\/home\/ubuntu\/\.claude\/projects\/[\w.\-]+$/.test(path)) return 'claude-session';
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === 'directory') return <span className="text-blue-400">📁</span>;
  if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) return <span>📘</span>;
  if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) return <span>📒</span>;
  if (entry.name.endsWith('.json')) return <span>📋</span>;
  if (entry.name.endsWith('.md')) return <span>📝</span>;
  if (entry.name.endsWith('.css') || entry.name.endsWith('.scss')) return <span>🎨</span>;
  if (entry.name.endsWith('.html')) return <span>🌐</span>;
  if (entry.name.startsWith('.')) return <span className="opacity-50">📄</span>;
  return <span>📄</span>;
}

// Staggered skeleton rows that appear one by one to simulate scanning
function FileSkeleton({ depth, count }: { depth: number; count: number }) {
  const [visible, setVisible] = useState(0);
  const [widths] = useState(() =>
    Array.from({ length: count }, () => 40 + Math.floor(Math.random() * 80)),
  );

  useEffect(() => {
    if (visible >= count) return;
    const id = setTimeout(() => setVisible((v) => v + 1), 80 + Math.random() * 60);
    return () => clearTimeout(id);
  }, [visible, count]);

  return (
    <div>
      {Array.from({ length: visible }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-2 py-1"
          style={{ paddingLeft: `${depth * 16 + (i < 2 ? 8 : 24)}px` }}
        >
          <Skeleton className="h-4 w-4 rounded shrink-0" />
          <Skeleton className="h-3.5 rounded" style={{ width: `${widths[i]}px` }} />
          {i >= 2 && <Skeleton className="ml-auto h-3 w-10 rounded" />}
        </div>
      ))}
      {visible < count && (
        <div
          className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <span className="animate-pulse">scanning...</span>
        </div>
      )}
    </div>
  );
}

// Full-page skeleton for initial root directory load
function RootSkeleton() {
  const [visible, setVisible] = useState(0);
  const total = 8;
  const [rows] = useState(() =>
    Array.from({ length: total }, () => ({
      isDir: Math.random() > 0.5,
      width: 50 + Math.floor(Math.random() * 100),
    })),
  );

  useEffect(() => {
    if (visible >= total) return;
    const id = setTimeout(() => setVisible((v) => v + 1), 100 + Math.random() * 80);
    return () => clearTimeout(id);
  }, [visible]);

  return (
    <div className="p-1">
      {Array.from({ length: visible }, (_, i) => {
        const row = rows[i];
        return (
          <div
            key={i}
            className="flex items-center gap-2 px-2 py-1.5"
            style={{ paddingLeft: '8px' }}
          >
            {row.isDir && <Skeleton className="h-3 w-3 rounded-sm shrink-0" />}
            <Skeleton className="h-4 w-4 rounded shrink-0" />
            <Skeleton className="h-3.5 rounded" style={{ width: `${row.width}px` }} />
            {!row.isDir && (
              <>
                <Skeleton className="ml-auto h-3 w-12 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </>
            )}
          </div>
        );
      })}
      {visible < total && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          <span>Scanning directory via SSM...</span>
        </div>
      )}
    </div>
  );
}

function DirectoryNode({
  path,
  name,
  depth,
  serverId,
}: {
  path: string;
  name: string;
  depth: number;
  serverId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data, isLoading, error } = useEc2Files(serverId, path, expanded);
  const deleteFolder = useDeleteEc2Folder();
  const kind = deletableKind(path);
  const canDelete = kind !== null;

  return (
    <div>
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded pr-1 text-sm hover:bg-accent transition-colors',
          expanded && 'text-accent-foreground',
        )}
      >
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-1 items-center gap-2 px-2 py-1 text-left"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <span
            className="text-xs text-muted-foreground transition-transform"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▸
          </span>
          <span className="text-blue-400">📁</span>
          <span className="truncate font-mono text-xs">{name}</span>
        </button>
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(true);
            }}
            disabled={deleteFolder.isPending}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100 disabled:cursor-wait"
            title={
              kind === 'project'
                ? `Delete ${path} (cascades to DynamoDB, S3, Claude transcripts)`
                : `Delete Claude Code session transcripts at ${path}`
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {confirmDelete && kind && (
        <DeleteConfirmDialog
          path={path}
          kind={kind}
          isPending={deleteFolder.isPending}
          error={deleteFolder.error instanceof Error ? deleteFolder.error.message : null}
          onCancel={() => {
            setConfirmDelete(false);
            deleteFolder.reset();
          }}
          onConfirm={() => {
            deleteFolder.mutate(path, {
              onSuccess: () => {
                setConfirmDelete(false);
                deleteFolder.reset();
              },
            });
          }}
        />
      )}

      {expanded && (
        <div>
          {isLoading && <FileSkeleton depth={depth + 1} count={5} />}
          {error && (
            <div
              className="py-1 text-xs text-red-400"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              {(error as Error).message}
            </div>
          )}
          {data?.entries.map((entry) =>
            entry.type === 'directory' ? (
              <DirectoryNode
                key={entry.name}
                path={`${path}/${entry.name}`}
                name={entry.name}
                depth={depth + 1}
                serverId={serverId}
              />
            ) : (
              <FileNode key={entry.name} entry={entry} parentPath={path} depth={depth + 1} />
            ),
          )}
          {data?.entries.length === 0 && (
            <div
              className="py-1 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              Empty directory
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeleteConfirmDialog({
  path,
  kind,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  path: string;
  kind: DeletableKind;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const projectName = path.split('/').filter(Boolean).pop() || '';
  // Only project-flow cascades into Claude transcripts. claude-session flow
  // IS the transcript folder, so no secondary target to display.
  const transcriptDir =
    kind === 'project'
      ? `/home/ubuntu/.claude/projects/-home-ubuntu-projects-${projectName}`
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-red-400">
          {kind === 'project' ? 'Delete project folder?' : 'Delete Claude Code session folder?'}
        </h3>
        <p className="text-xs text-muted-foreground">
          {kind === 'project' ? (
            <>
              This will permanently <code className="font-mono">rm -rf</code> the project on EC2 AND
              its Claude Code transcripts, AND remove related epic records, agent jobs,
              project-registry entries, Labs party-project + session rows, and{' '}
              <code className="font-mono">apps/{projectName}/</code> artifacts in S3. Cannot be
              undone.
            </>
          ) : (
            <>
              This will permanently <code className="font-mono">rm -rf</code> the Claude Code
              session transcript folder. Cannot be undone. AWS resources are not affected.
            </>
          )}
        </p>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {kind === 'project' ? 'Project source' : 'Target folder'}
          </p>
          <code className="block rounded bg-muted px-2 py-1.5 text-[11px] font-mono break-all">
            {path}
          </code>
          {transcriptDir && (
            <>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Claude Code transcripts (cascaded)
              </p>
              <code className="block rounded bg-muted px-2 py-1.5 text-[11px] font-mono break-all opacity-80">
                {transcriptDir}
              </code>
            </>
          )}
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileNode({
  entry,
  parentPath,
  depth,
}: {
  entry: FileEntry;
  parentPath: string;
  depth: number;
}) {
  const { activePath, openFile } = useContext(TabsContext);
  const fullPath = `${parentPath}/${entry.name}`;
  const isActive = activePath === fullPath;
  return (
    <button
      type="button"
      onClick={() => openFile(fullPath, entry.name)}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors',
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-foreground',
      )}
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
    >
      <FileIcon entry={entry} />
      <span className="truncate font-mono text-xs">{entry.name}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">{formatSize(entry.size)}</span>
      <span className="text-[10px] text-muted-foreground font-mono">{entry.permissions}</span>
    </button>
  );
}

export function FileExplorer() {
  const searchParams = useSearchParams();
  // No hardcoded root: an empty path lets the daemon default to the selected
  // server's own scoped browse root, echoed back as `data.path`.
  const initialPath = searchParams.get('path') || '';
  const { data: serversData } = useServers();
  const servers = useMemo(() => serversData?.servers ?? [], [serversData]);
  // Tick a wall-clock so heartbeat banding stays live between server polls
  // (matches the Servers-tab card idiom; Date.now() during render is impure).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  // Root-path (tree) + input box. Empty string == the server's scoped browse
  // root; the daemon echoes the resolved absolute path back in `data.path`,
  // which we use as the base for child paths and the breadcrumb.
  const [rootPath, setRootPath] = useState(initialPath);
  const [inputPath, setInputPath] = useState(initialPath);

  // Open-tabs state lives at the root so it survives tree expansion/collapse
  // and (intentionally) folder navigation — switching breadcrumb shouldn't
  // wipe what you have open. Keyed by full path; one entry per file.
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  // Default pick, derived (not stored via an effect): first fresh box,
  // preferring a local runner. `selectedServerId` only ever holds the
  // operator's explicit choice; a box that goes merely stale keeps its slot so
  // the "heartbeat stale" state shows instead of silently jumping away.
  const defaultServerId = useMemo(() => {
    const fresh = servers.filter((s) => heartbeatState(s.lastHeartbeatAt, now) === 'fresh');
    return (fresh.find((s) => s.provider === 'local') ?? fresh[0])?.serverId ?? null;
  }, [servers, now]);
  const effectiveServerId =
    selectedServerId && servers.some((s) => s.serverId === selectedServerId)
      ? selectedServerId
      : defaultServerId;

  const selectedServer = servers.find((s) => s.serverId === effectiveServerId) ?? null;
  const selectedBeat = selectedServer ? heartbeatState(selectedServer.lastHeartbeatAt, now) : null;
  const canBrowse = selectedBeat === 'fresh';
  // Only route file calls to a fresh server — the hook's `!!serverId` gate then
  // keeps the whole tree silent until a live box is picked ("no selection →
  // zero file calls"). A dead/stale box never fires a request or blocks the UI.
  const browseServerId = canBrowse ? effectiveServerId : null;
  const { data, isLoading, error, refetch } = useEc2Files(browseServerId, rootPath, true);
  // Base for root children + breadcrumb: prefer the daemon-resolved absolute
  // root so an empty `rootPath` still yields correct child paths.
  const resolvedRoot = data?.path ?? rootPath;

  const openFile = useCallback((path: string, name: string) => {
    setOpenTabs((prev) => {
      if (prev.some((t) => t.id === path)) return prev;
      return [...prev, { id: path, path, name }];
    });
    setActivePath(path);
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === path);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== path);
        // If we closed the active tab, fall back to the neighbor on the left
        // (or right if we were at index 0). Otherwise leave activePath alone.
        if (activePath === path) {
          const fallback = next[idx - 1] ?? next[idx] ?? null;
          setActivePath(fallback ? fallback.id : null);
        }
        return next;
      });
    },
    [activePath],
  );

  const handleNavigate = useCallback(() => {
    setRootPath(inputPath);
  }, [inputPath]);

  // Switching servers re-roots the tree: paths from another box don't map onto
  // this one, and any open tab would refetch its old path against the new
  // server. Start clean at the new box's scoped root.
  const handleSelectServer = useCallback((id: string) => {
    setSelectedServerId(id);
    setRootPath('');
    setInputPath('');
    setOpenTabs([]);
    setActivePath(null);
  }, []);

  const activeTab = openTabs.find((t) => t.id === activePath) ?? null;

  return (
    <TabsContext.Provider value={{ activePath, openFile }}>
      <div className="space-y-4">
        {/* Server picker — always visible so a dead/stale box never blocks the
            panel; the operator can just pick another. */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">Server</label>
          <select
            value={effectiveServerId ?? ''}
            onChange={(e) => handleSelectServer(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="" disabled>
              Pick a server…
            </option>
            {servers.map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.name} · {s.provider} · {heartbeatState(s.lastHeartbeatAt, now)}
              </option>
            ))}
          </select>
        </div>

        {!selectedServer ? (
          <EmptyPanel
            title="Pick a server"
            detail="Choose a fleet host above to browse its filesystem."
          />
        ) : !canBrowse ? (
          <EmptyPanel
            title="Heartbeat stale"
            detail={`${selectedServer.name} hasn't reported in recently, so its filesystem can't be browsed. Pick a fresh server or wait for it to recover.`}
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm"
                placeholder="server root"
              />
              <button
                onClick={handleNavigate}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium hover:bg-accent/80 transition-colors"
              >
                Go
              </button>
              <button
                onClick={() => refetch()}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                ↻
              </button>
            </div>

            {/* Split pane: tree (left) + viewer (right). On narrow viewports the
                viewer drops below; on lg+ they sit side-by-side at ~40/60. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,2fr)_minmax(420px,3fr)]">
              {/* ── Tree ── */}
              <div className="rounded-lg border border-border bg-card">
                <div className="border-b border-border px-3 py-2">
                  <Breadcrumb
                    path={resolvedRoot}
                    onNavigate={(p) => {
                      setRootPath(p);
                      setInputPath(p);
                    }}
                  />
                </div>
                <div className="h-[calc(100vh-260px)] overflow-y-auto">
                  {isLoading && <RootSkeleton />}
                  {error && (
                    <div className="p-4 text-sm text-red-400">{(error as Error).message}</div>
                  )}
                  {data?.entries.map((entry) =>
                    entry.type === 'directory' ? (
                      <DirectoryNode
                        key={entry.name}
                        path={`${resolvedRoot}/${entry.name}`}
                        name={entry.name}
                        depth={0}
                        serverId={selectedServer.serverId}
                      />
                    ) : (
                      <FileNode
                        key={entry.name}
                        entry={entry}
                        parentPath={resolvedRoot}
                        depth={0}
                      />
                    ),
                  )}
                  {data && data.entries.length === 0 && (
                    <div className="p-4 text-sm text-muted-foreground italic">Empty directory</div>
                  )}
                </div>
              </div>

              {/* ── Viewer pane ── */}
              <div className="flex h-[calc(100vh-260px)] min-h-0 flex-col rounded-lg border border-border bg-card">
                <ViewerTabs
                  tabs={openTabs}
                  activePath={activePath}
                  onSelect={setActivePath}
                  onClose={closeTab}
                />
                <div className="min-h-0 flex-1 overflow-hidden">
                  {activeTab ? (
                    <FileViewer
                      key={activeTab.id}
                      tab={activeTab}
                      serverId={selectedServer.serverId}
                    />
                  ) : (
                    <EmptyViewerState />
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </TabsContext.Provider>
  );
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <p className="text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function ViewerTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
}: {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.length === 0) {
    return (
      <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        No file open
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-background">
      {tabs.map((tab) => {
        const isActive = tab.id === activePath;
        return (
          <div
            key={tab.id}
            className={cn(
              'group relative flex items-center gap-2 border-r border-border px-3 py-1.5 text-xs transition-colors',
              isActive
                ? 'bg-card text-foreground'
                : 'bg-background text-muted-foreground hover:bg-card/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              className="font-mono"
              title={tab.path}
            >
              {tab.name}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
              title="Close tab"
            >
              <X className="h-3 w-3" />
            </button>
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-px bg-accent-foreground/40" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyViewerState() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <div>
        <p>Click a file in the tree to preview it here.</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Text, markdown, code, images and PDFs supported. Other binaries can be downloaded.
        </p>
      </div>
    </div>
  );
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <div className="flex items-center gap-1 text-sm font-mono">
      <button
        onClick={() => onNavigate('/')}
        className="text-muted-foreground hover:text-foreground"
      >
        /
      </button>
      {parts.map((part, i) => {
        const fullPath = '/' + parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <span key={fullPath} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            {isLast ? (
              <span className="text-foreground">{part}</span>
            ) : (
              <button
                onClick={() => onNavigate(fullPath)}
                className="text-muted-foreground hover:text-foreground"
              >
                {part}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
