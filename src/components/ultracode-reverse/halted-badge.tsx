'use client';

import { Badge } from '@/components/ui/badge';
import type { UltracodeSideStatus } from '@/types/ultracode-run';

/** Per-engine status badge for the dual live view. */
export function HaltedBadge({ status }: { status: UltracodeSideStatus }) {
  switch (status) {
    case 'RUNNING':
      return (
        <Badge variant="secondary" className="animate-pulse">
          running…
        </Badge>
      );
    case 'HALTED':
      return <Badge variant="default">HALTED @ plan produced</Badge>;
    case 'COMPLETE':
      return <Badge variant="default">complete</Badge>;
    case 'ERROR':
      return <Badge variant="destructive">error</Badge>;
    case 'PENDING':
    default:
      return <Badge variant="outline">awaiting daemon</Badge>;
  }
}
