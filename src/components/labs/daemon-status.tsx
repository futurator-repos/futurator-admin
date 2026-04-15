'use client';
import { useDaemonStatus } from '@/hooks/use-daemon-status';

export function DaemonStatus() {
  const { data, isLoading } = useDaemonStatus();

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="hidden sm:inline">Daemon</span>
      </div>
    );
  }

  const alive = data?.alive ?? false;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`h-2 w-2 rounded-full ${alive ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className={`hidden sm:inline ${alive ? 'text-muted-foreground' : 'text-red-400'}`}>
        Daemon
      </span>
    </div>
  );
}
