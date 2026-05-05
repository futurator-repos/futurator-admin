'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Loader2, X, FileText, Copy, Check } from 'lucide-react';
import { usePartyFile } from '@/hooks/use-party-file';
import { RichText } from '../rich-text';
import { COLORS } from './tokens';

/**
 * File-preview drawer state — consumed via FileDrawerContext from anywhere
 * inside the chat. The drawer itself is a true floating overlay (z-50,
 * fixed position, click-outside to close), not an inline pane that pushes
 * the chat content.
 */
interface FileDrawerState {
  projectId: string;
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
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState<FileDrawerState | null>(null);

  const openPath = useCallback(
    (path: string) => {
      if (!projectId) return; // no project context — nothing to fetch from
      setCurrent({ projectId, path });
    },
    [projectId],
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
function FileDrawer({
  state,
  onClose,
}: {
  state: FileDrawerState;
  onClose: () => void;
}) {
  const { data, isLoading, error } = usePartyFile(state.projectId, state.path);
  const [copied, setCopied] = useState(false);

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
      <div
        className="flex-1 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      {/* Panel */}
      <div
        className="party-drawer-panel flex w-full max-w-[680px] flex-col shadow-2xl"
        style={{
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
          <FileText className="h-4 w-4 shrink-0" style={{ color: COLORS.accentBrand }} />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[14px] font-semibold"
              style={{ color: COLORS.textPrimary }}
              title={state.path}
            >
              {filename}
            </div>
            <div
              className="truncate font-mono text-[10.5px]"
              style={{ color: COLORS.textMuted }}
            >
              {state.path}
              {data && (
                <>
                  {' · '}
                  {formatBytes(data.size)}
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
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
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
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
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
                background: 'rgba(248,113,113,0.08)',
                borderColor: 'rgba(248,113,113,0.3)',
                color: '#fca5a5',
              }}
            >
              <div className="font-semibold">Couldn&apos;t open file</div>
              <div className="mt-1 opacity-80">
                {(error as Error).message ||
                  'The file may have been moved or deleted since the agent referenced it.'}
              </div>
            </div>
          )}

          {data && !isLoading && (
            <FileBody contentType={data.contentType} content={data.content} path={state.path} />
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
