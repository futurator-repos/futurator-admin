'use client';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAssignments, useServers } from '@/hooks/use-servers';
import type { ServerAssignment } from '@/types/servers';

const AFFINITY_OWNER_UNREACHABLE = 'affinity owner unreachable';

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'RUNNING' ? 'outline' : status === 'PENDING' ? 'secondary' : 'outline';
  const className = status === 'RUNNING' ? 'border-success text-success' : '';
  return (
    <Badge variant={variant} className={className}>
      {status}
    </Badge>
  );
}

function AssignmentRow({
  assignment,
  serverName,
}: {
  assignment: ServerAssignment;
  serverName: string;
}) {
  const paused = (assignment.assignReason ?? '').includes(AFFINITY_OWNER_UNREACHABLE);
  return (
    <>
      <TableRow className={cn(paused && 'bg-warning/10 hover:bg-warning/15')}>
        <TableCell className="font-mono text-xs">{shortId(assignment.jobId)}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{assignment.jobType ?? '—'}</TableCell>
        <TableCell>
          <StatusBadge status={assignment.status} />
        </TableCell>
        <TableCell className="text-xs">{serverName}</TableCell>
        <TableCell
          className="max-w-[24rem] truncate text-xs text-muted-foreground"
          title={assignment.assignReason}
        >
          {assignment.assignReason ?? '—'}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(assignment.createdAt), { addSuffix: true })}
        </TableCell>
      </TableRow>
      {paused && (
        <TableRow className="bg-warning/10 hover:bg-warning/10">
          <TableCell colSpan={6} className="whitespace-normal py-2 text-xs text-warning">
            Plan paused — server down. Recover the server or destroy it to re-dispatch non-affinity
            work.
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Recent server-assigned agent-jobs, newest first — lets an operator verify
 * the current dispatch policy is actually behaving as expected (spec §8). */
export function AssignmentsFeed() {
  const { data: assignments, isLoading, error } = useAssignments();
  const { data: serversData } = useServers();
  const serverNameById = new Map(
    (serversData?.servers ?? []).map((s) => [s.serverId, s.name] as const),
  );

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading assignments…</p>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load assignments: {(error as Error).message}
      </div>
    );
  }

  const rows = assignments ?? [];

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No assigned jobs yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Server</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <AssignmentRow
              key={a.jobId}
              assignment={a}
              serverName={
                a.assignedServerId
                  ? (serverNameById.get(a.assignedServerId) ?? a.assignedServerId)
                  : '—'
              }
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
