'use client';
import type { BmadStatus } from '@/types/party';

const STATUS_STYLES: Record<BmadStatus, { label: string; className: string }> = {
  HEALTHY: {
    label: 'Healthy',
    className: 'bg-green-900/40 text-green-400 border border-green-900/60',
  },
  DRIFTED: {
    label: 'Drifted',
    className: 'bg-yellow-900/40 text-yellow-400 border border-yellow-900/60',
  },
  INSTALLING: {
    label: 'Installing…',
    className: 'bg-blue-900/40 text-blue-400 border border-blue-900/60 animate-pulse',
  },
  MISSING: { label: 'Missing', className: 'bg-muted text-muted-foreground border border-border' },
  FAILED: { label: 'Failed', className: 'bg-red-900/40 text-red-400 border border-red-900/60' },
  CORRUPTED: {
    label: 'Corrupted',
    className: 'bg-red-900/40 text-red-400 border border-red-900/60',
  },
  // Story 15.4 — brownfield refresh in progress. Same blue-pulse tone as
  // INSTALLING since the UX intent is the same: a transient busy state.
  REFRESHING: {
    label: 'Refreshing…',
    className: 'bg-blue-900/40 text-blue-400 border border-blue-900/60 animate-pulse',
  },
};

interface Props {
  status: BmadStatus;
  title?: string;
}

export function ProjectStatusBadge({ status, title }: Props) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.MISSING;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${style.className}`}
      title={title}
    >
      {style.label}
    </span>
  );
}
