'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FreeAgentMessageThread,
  type FreeAgentMessage,
} from '@/components/free-agent/message-thread';
import { HaltedBadge } from './halted-badge';
import type { UltracodeSideStatus } from '@/types/ultracode-run';

interface SidePanelProps {
  title: string;
  subtitle: string;
  status: UltracodeSideStatus;
  messages: FreeAgentMessage[];
  processing: boolean;
}

function SidePanel({ title, subtitle, status, messages, processing }: SidePanelProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <HaltedBadge status={status} />
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <div className="h-[420px] overflow-hidden">
          {messages.length === 0 && status === 'PENDING' ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Awaiting the daemon to start this engine.
            </div>
          ) : (
            <FreeAgentMessageThread messages={messages} isProcessing={processing} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface DualLiveViewProps {
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  case1Messages: FreeAgentMessage[];
  case2Messages: FreeAgentMessage[];
}

export function DualLiveView({
  case1Status,
  case2Status,
  case1Messages,
  case2Messages,
}: DualLiveViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SidePanel
        title="Case 1 — ultracode (native, captured)"
        subtitle="claude · Opus 4.8 · xhigh — halted on plan produced"
        status={case1Status}
        messages={case1Messages}
        processing={case1Status === 'RUNNING'}
      />
      <SidePanel
        title="Case 2 — Futurator meta-prompt"
        subtitle="claude · Opus 4.8 · xhigh — same frame, our prompt"
        status={case2Status}
        messages={case2Messages}
        processing={case2Status === 'RUNNING'}
      />
    </div>
  );
}
