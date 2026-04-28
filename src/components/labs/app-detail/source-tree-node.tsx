'use client';

/**
 * Story 1.5.2 — Recursive tree node for the GitHub source tree.
 *
 * Why new file: `file-explorer.tsx`'s DirectoryNode is unexported and tightly
 * coupled to EC2 SSM file APIs + delete affordances. The GitHub tree is a flat
 * array of paths that we reshape into a virtual hierarchy client-side.
 *
 * A11y: fully keyboard navigable via arrow keys + Enter/Space on buttons.
 */

import { useState, useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Virtual tree node shape built from the flat TreeEntry[] ────────────────

export interface VirtualNode {
  name: string;
  path: string;
  type: 'blob' | 'tree';
  children: VirtualNode[];
  sha: string;
  size?: number;
}

/**
 * buildVirtualTree — convert GitHub's flat path array into a hierarchical
 * VirtualNode tree, sorted: directories first then files (both alphabetical).
 */
export function buildVirtualTree(
  entries: { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }[],
): VirtualNode[] {
  const root: VirtualNode = {
    name: '',
    path: '',
    type: 'tree',
    children: [],
    sha: '',
  };

  for (const entry of entries) {
    // Skip commit entries (git submodules)
    if (entry.type === 'commit') continue;

    const parts = entry.path.split('/');
    let cursor = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        cursor.children.push({
          name: part,
          path: entry.path,
          type: entry.type as 'blob' | 'tree',
          children: [],
          sha: entry.sha,
          size: entry.size,
        });
      } else {
        let child = cursor.children.find((c) => c.name === part && c.type === 'tree');
        if (!child) {
          child = {
            name: part,
            path: parts.slice(0, i + 1).join('/'),
            type: 'tree',
            children: [],
            sha: '',
          };
          cursor.children.push(child);
        }
        cursor = child;
      }
    }
  }

  sortNodes(root.children);
  return root.children;
}

function sortNodes(nodes: VirtualNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children.length > 0) sortNodes(node.children);
  }
}

// ── Icon helpers ────────────────────────────────────────────────────────────

function fileEmoji(name: string): string {
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return '📘';
  if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) return '📒';
  if (name.endsWith('.json')) return '📋';
  if (name.endsWith('.md') || name.endsWith('.mdx')) return '📝';
  if (name.endsWith('.css') || name.endsWith('.scss')) return '🎨';
  if (name.endsWith('.html')) return '🌐';
  if (name.startsWith('.')) return '📄';
  return '📄';
}

// ── Single node ─────────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: VirtualNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function DirNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
      if (e.key === 'ArrowRight' && !expanded) {
        e.preventDefault();
        setExpanded(true);
      }
      if (e.key === 'ArrowLeft' && expanded) {
        e.preventDefault();
        setExpanded(false);
      }
    },
    [expanded, toggle],
  );

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={false}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', {
            'rotate-90': expanded,
          })}
          aria-hidden
        />
        <span className="text-blue-400" aria-hidden>
          📁
        </span>
        <span className="truncate font-mono text-xs">{node.name}</span>
      </button>
      {expanded && node.children.length > 0 && (
        <div role="group">
          {node.children.map((child) => (
            <SourceTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  const isSelected = selectedPath === node.path;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(node.path);
      }
    },
    [node.path, onSelect],
  );

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={isSelected}
      onClick={() => onSelect(node.path)}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelected ? 'bg-accent-blue/15 text-accent-blue' : 'hover:bg-accent/50',
      )}
      style={{ paddingLeft: `${depth * 14 + 24}px` }}
    >
      <span aria-hidden>{fileEmoji(node.name)}</span>
      <span className="truncate font-mono text-xs">{node.name}</span>
    </button>
  );
}

/**
 * SourceTreeNode — renders a single VirtualNode recursively.
 * Pass depth=0 for top-level nodes.
 */
export function SourceTreeNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  if (node.type === 'tree') {
    return <DirNode node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />;
  }
  return <FileNode node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />;
}
