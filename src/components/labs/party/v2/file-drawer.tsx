'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Loader2, X, FileText, Copy, Check, Folder } from 'lucide-react';
import { usePartyFile } from '@/hooks/use-party-file';
import { RichText } from '../rich-text';
import { COLORS, DRAWER_DEFAULTS, DRAWER_WIDTH_KEY } from './tokens';

function clampWidth(v: number) {
  return Math.max(DRAWER_DEFAULTS.min, Math.min(DRAWER_DEFAULTS.max, v));
}

function loadDrawerWidth(): number {
  if (typeof window === 'undefined') return DRAWER_DEFAULTS.width;
  try {
    const raw = window.localStorage.getItem(DRAWER_WIDTH_KEY);
    if (raw) return clampWidth(Number.parseInt(raw, 10) || DRAWER_DEFAULTS.width);
  } catch {
    /* ignore — fall through */
  }
  return DRAWER_DEFAULTS.width;
}

/**
 * File-preview drawer state — consumed via FileDrawerContext from anywhere
 * inside the chat. The drawer itself is a true floating overlay (z-50,
 * fixed position, click-outside to close), not an inline pane that pushes
 * the chat content.
 */
interface FileDrawerState {
  projectId: string;
  /** Active debate session — resolves the per-session worktree read root. */
  sessionId: string | null;
  /** Project-relative path. */
  path: string;
}

interface FileDrawerCtx {
  /**
   * Open a file from the active Party project. RichText calls this with
   * just a path; the projectId is injected by the provider so deep child
   * components don't have to prop-drill it.
   */
  openPath: (path: string) => void;
  close: () => void;
  current: FileDrawerState | null;
  /** True when the drawer is wired up; false in standalone RichText usage. */
  enabled: boolean;
}

const Ctx = createContext<FileDrawerCtx>({
  openPath: () => {},
  close: () => {},
  current: null,
  enabled: false,
});

/**
 * Wrap any subtree that needs to open the drawer. Renders the drawer once
 * at the root so multiple click sources (rich text, tool log, …) share one
 * overlay instance.
 */
export function FileDrawerProvider({
  projectId,
  sessionId = null,
  children,
}: {
  projectId: string | null;
  /** Active debate session — threaded to the read API to target its worktree. */
  sessionId?: string | null;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState<FileDrawerState | null>(null);

  const openPath = useCallback(
    (path: string) => {
      if (!projectId) return; // no project context — nothing to fetch from
      setCurrent({ projectId, sessionId, path });
    },
    [projectId, sessionId],
  );
  const close = useCallback(() => setCurrent(null), []);

  // Esc to close.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, close]);

  const value = useMemo<FileDrawerCtx>(
    () => ({ openPath, close, current, enabled: !!projectId }),
    [openPath, close, current, projectId],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {current && <FileDrawer state={current} onClose={close} />}
    </Ctx.Provider>
  );
}

export function useFileDrawer(): FileDrawerCtx {
  return useContext(Ctx);
}

/**
 * The actual overlay. Renders as fixed position with a backdrop. Closes on
 * backdrop click and Esc.
 */
function FileDrawer({ state, onClose }: { state: FileDrawerState; onClose: () => void }) {
  const { data, isLoading, error } = usePartyFile(state.projectId, state.path, state.sessionId);
  const { openPath } = useFileDrawer();
  const [copied, setCopied] = useState(false);
  const isDir = data?.kind === 'dir';

  // Resizable width — persisted to localStorage. Same drag model as the
  // three-column pane handles, but lives next to the drawer so it doesn't
  // need the global pane-resize context.
  const [width, setWidth] = useState<number>(() => loadDrawerWidth());
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
    } catch {
      /* quota / private mode — best effort */
    }
  }, [width]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const start = dragStart.current;
      if (!start) return;
      // Handle is on the LEFT edge of a right-anchored panel — dragging
      // left grows the panel, dragging right shrinks it.
      const dx = e.clientX - start.x;
      setWidth(clampWidth(start.width - dx));
    }
    function onUp() {
      setDragging(false);
      dragStart.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width };
    setDragging(true);
  }

  async function copy() {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* noop */
    }
  }

  const filename = state.path.split('/').pop() || state.path;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      {/* Resize handle — anchored on the LEFT edge of the right-side panel. */}
      <div
        className="party-resize-handle"
        data-dragging={dragging ? 'true' : 'false'}
        onMouseDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file preview"
      />
      {/* Panel */}
      <div
        className="party-drawer-panel flex flex-col shadow-2xl"
        style={{
          width,
          maxWidth: '100vw',
          background: COLORS.bgContent,
          borderLeft: `1px solid ${COLORS.bgDeepest}`,
        }}
      >
        <header
          className="flex shrink-0 items-center gap-3 px-4"
          style={{
            height: 56,
            borderBottom: `1px solid ${COLORS.bgDeepest}`,
          }}
        >
          {isDir ? (
            <Folder className="h-4 w-4 shrink-0" style={{ color: COLORS.accentBrand }} />
          ) : (
            <FileText className="h-4 w-4 shrink-0" style={{ color: COLORS.accentBrand }} />
          )}
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[14px] font-semibold"
              style={{ color: COLORS.textPrimary }}
              title={state.path}
            >
              {filename}
            </div>
            <div className="truncate font-mono text-[10.5px]" style={{ color: COLORS.textMuted }}>
              {state.path}
              {data && typeof data.size === 'number' && (
                <>
                  {' · '}
                  {formatBytes(data.size)}
                </>
              )}
              {isDir && data?.entries && (
                <>
                  {' · '}
                  {data.entries.length} item{data.entries.length === 1 ? '' : 's'}
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={copy}
            disabled={!data?.content}
            title={copied ? 'Copied' : 'Copy file content'}
            className="rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: COLORS.textMuted }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background =
                'color-mix(in srgb, var(--foreground) 8%, transparent)';
              e.currentTarget.style.color = COLORS.textPrimary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = COLORS.textMuted;
            }}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 transition-colors"
            style={{ color: COLORS.textMuted }}
            title="Close (Esc)"
            onMouseEnter={(e) => {
              e.currentTarget.style.background =
                'color-mix(in srgb, var(--foreground) 8%, transparent)';
              e.currentTarget.style.color = COLORS.textPrimary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = COLORS.textMuted;
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div
              className="flex items-center justify-center py-12 text-[12px]"
              style={{ color: COLORS.textMuted }}
            >
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Reading file…
            </div>
          )}

          {error && (
            <div
              className="rounded-md border px-3 py-2 text-[12.5px]"
              style={{
                background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
                borderColor: 'color-mix(in srgb, var(--destructive) 35%, transparent)',
                color: 'var(--destructive)',
              }}
            >
              <div className="font-semibold">Couldn&apos;t open file</div>
              <div className="mt-1 opacity-80">
                {(error as Error).message ||
                  'The file may have been moved or deleted since the agent referenced it.'}
              </div>
            </div>
          )}

          {data && !isLoading && isDir && (
            <DirListing
              basePath={data.path}
              entries={data.entries ?? []}
              onOpen={(p) => openPath(p)}
            />
          )}

          {data && !isLoading && !isDir && (
            <FileBody
              contentType={data.contentType ?? 'text/plain'}
              content={data.content ?? ''}
              path={state.path}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Render the file body. Markdown gets the same RichText pipeline as agent
 * messages so internal links chain naturally. Other text shows as a
 * monospace block with line numbers off (we don't need them in a preview).
 */
function FileBody({
  contentType,
  content,
  path,
}: {
  contentType: string;
  content: string;
  path: string;
}) {
  if (contentType === 'text/markdown') {
    return <RichText text={content} />;
  }
  // For everything else, show as code with the right language hint so the
  // existing CodeBlock highlighter does its thing.
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const fenced = '```' + ext + '\n' + content + '\n```';
  return <RichText text={fenced} />;
}

/**
 * Mini file explorer for directory paths (e.g. the orchestrator references
 * `docs/prd/<feature>/`). Each row re-opens the drawer at the child path —
 * files preview, directories drill deeper. A `..` row walks back up while
 * there's still a parent inside the project root.
 */
function DirListing({
  basePath,
  entries,
  onOpen,
}: {
  basePath: string;
  entries: Array<{ name: string; type: 'dir' | 'file'; size: number }>;
  onOpen: (path: string) => void;
}) {
  const parent = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : null;
  return (
    <div className="space-y-0.5">
      {parent !== null && <DirRow name=".." type="dir" onClick={() => onOpen(parent)} />}
      {entries.length === 0 && (
        <div className="px-2 py-4 text-[12px] italic" style={{ color: COLORS.textMuted }}>
          Empty directory.
        </div>
      )}
      {entries.map((e) => (
        <DirRow
          key={e.name}
          name={e.name}
          type={e.type}
          size={e.size}
          onClick={() => onOpen(`${basePath}/${e.name}`)}
        />
      ))}
    </div>
  );
}

function DirRow({
  name,
  type,
  size,
  onClick,
}: {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--foreground) 5%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {type === 'dir' ? (
        <Folder className="h-4 w-4 shrink-0" style={{ color: COLORS.accentBrand }} />
      ) : (
        <FileText className="h-4 w-4 shrink-0" style={{ color: COLORS.textMuted }} />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: COLORS.textPrimary }}>
        {name}
        {type === 'dir' ? '/' : ''}
      </span>
      {type === 'file' && typeof size === 'number' && (
        <span className="shrink-0 font-mono text-[10.5px]" style={{ color: COLORS.textMuted }}>
          {formatBytes(size)}
        </span>
      )}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
