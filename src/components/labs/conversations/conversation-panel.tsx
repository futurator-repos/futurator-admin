'use client';
/**
 * Pipeline v1 — Story 3.7. Conversation panel.
 *
 * Slide-out drawer the operator opens via "Talk" on a failed-step panel.
 * Lets them pick a mode (fresh / resume), send messages, and apply the
 * output back to the canonical job. Minimal v1 — chat scroll + composer
 * + apply button. Cost preview lives in the mode selector.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  useCreateConversation,
  useSendMessage,
  useApplyConversationOutput,
  useConversationEvents,
} from '@/hooks/use-conversations';

interface ConversationPanelProps {
  jobId: string;
  stepId: string;
  onClose: () => void;
}

type Mode = 'fresh' | 'resume' | 'compact-resume';

export function ConversationPanel({ jobId, stepId, onClose }: ConversationPanelProps) {
  const [mode, setMode] = useState<Mode>('fresh');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [sentMessages, setSentMessages] = useState<string[]>([]);

  const create = useCreateConversation();
  const send = useSendMessage(conversationId);
  const apply = useApplyConversationOutput();
  const events = useConversationEvents(conversationId);

  const handleStart = () => {
    create.mutate(
      { jobId, stepId, mode },
      {
        onSuccess: (r) => setConversationId(r.conversationId),
      },
    );
  };

  const handleSend = () => {
    if (!content.trim()) return;
    setSentMessages((prev) => [...prev, content]);
    send.mutate(content);
    setContent('');
  };

  return (
    <aside className="fixed right-0 top-0 h-screen w-[480px] border-l bg-background shadow-xl flex flex-col z-50">
      <header className="flex items-center justify-between p-3 border-b">
        <div>
          <div className="text-sm font-medium">Talk to agent</div>
          <div className="text-xs text-muted-foreground">
            step: <span className="font-mono">{stepId}</span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>

      {!conversationId ? (
        <div className="p-4 space-y-4">
          <div>
            <div className="text-sm font-medium mb-2">Start a conversation</div>
            <div className="space-y-2 text-sm">
              <ModeRow value="fresh" mode={mode} setMode={setMode} cost="$0.01 (cold start)" />
              <ModeRow
                value="resume"
                mode={mode}
                setMode={setMode}
                cost="$0.04 (warm) / $0.31 (cold)"
              />
              <ModeRow
                value="compact-resume"
                mode={mode}
                setMode={setMode}
                cost="not implemented (Epic 5)"
                disabled
              />
            </div>
          </div>
          <Button onClick={handleStart} disabled={create.isPending}>
            {create.isPending ? 'Opening…' : 'Open conversation'}
          </Button>
          {create.isError && (
            <div className="text-xs text-destructive">{(create.error as Error).message}</div>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto p-3 space-y-3 text-sm">
            {sentMessages.map((m, i) => (
              <div key={`u-${i}`} className="rounded bg-muted p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">you</div>
                {m}
              </div>
            ))}
            {events.data?.events.map((e, i) => (
              <div key={`a-${i}`} className="rounded border p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">agent</div>
                <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(e)}</pre>
              </div>
            ))}
            {send.isPending && (
              <div className="text-xs text-muted-foreground italic">agent is thinking…</div>
            )}
          </div>

          <div className="border-t p-3 space-y-2">
            <Textarea
              placeholder="Ask the agent…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
            />
            <div className="flex justify-between items-center">
              <Badge variant="outline" className="text-[10px]">
                {mode}
              </Badge>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => apply.mutate(conversationId)}
                  disabled={apply.isPending}
                >
                  Apply this output
                </Button>
                <Button size="sm" onClick={handleSend} disabled={send.isPending || !content.trim()}>
                  Send
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function ModeRow({
  value,
  mode,
  setMode,
  cost,
  disabled,
}: {
  value: Mode;
  mode: Mode;
  setMode: (m: Mode) => void;
  cost: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <input
        type="radio"
        name="conversation-mode"
        value={value}
        checked={mode === value}
        onChange={() => !disabled && setMode(value)}
        disabled={disabled}
      />
      <span className="font-mono text-xs">{value}</span>
      <span className="text-muted-foreground text-xs">— {cost}</span>
    </label>
  );
}
