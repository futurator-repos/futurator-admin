'use client';
import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useEc2Files, type FileEntry } from '@/hooks/use-ec2-files';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const ROOT_PATH = '/home/ubuntu';

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
  ec2Running,
}: {
  path: string;
  name: string;
  depth: number;
  ec2Running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useEc2Files(path, expanded && ec2Running);

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent transition-colors',
          expanded && 'text-accent-foreground',
        )}
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
                ec2Running={ec2Running}
              />
            ) : (
              <FileNode key={entry.name} entry={entry} depth={depth + 1} />
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

function FileNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent/50 transition-colors"
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
    >
      <FileIcon entry={entry} />
      <span className="truncate font-mono text-xs">{entry.name}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">{formatSize(entry.size)}</span>
      <span className="text-[10px] text-muted-foreground font-mono">{entry.permissions}</span>
    </div>
  );
}

export function FileExplorer() {
  const searchParams = useSearchParams();
  const initialPath = searchParams.get('path') || ROOT_PATH;
  const { data: ec2Status } = useEc2Status(true);
  const ec2Running = ec2Status?.state === 'running';
  const [rootPath, setRootPath] = useState(initialPath);
  const [inputPath, setInputPath] = useState(initialPath);
  const { data, isLoading, error, refetch } = useEc2Files(rootPath, ec2Running);

  const handleNavigate = useCallback(() => {
    setRootPath(inputPath);
  }, [inputPath]);

  if (!ec2Running) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">EC2 instance is not running.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Start the instance from the Labs page to browse files.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={inputPath}
          onChange={(e) => setInputPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm"
          placeholder="/home/ubuntu"
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

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2">
          <Breadcrumb
            path={rootPath}
            onNavigate={(p) => {
              setRootPath(p);
              setInputPath(p);
            }}
          />
        </div>
        <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
          {isLoading && <RootSkeleton />}
          {error && <div className="p-4 text-sm text-red-400">{(error as Error).message}</div>}
          {data?.entries.map((entry) =>
            entry.type === 'directory' ? (
              <DirectoryNode
                key={entry.name}
                path={`${rootPath}/${entry.name}`}
                name={entry.name}
                depth={0}
                ec2Running={ec2Running}
              />
            ) : (
              <FileNode key={entry.name} entry={entry} depth={0} />
            ),
          )}
          {data && data.entries.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground italic">Empty directory</div>
          )}
        </div>
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
