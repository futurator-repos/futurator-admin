'use client';
import { useState } from 'react';
import { useCreateTestRequest } from '@/hooks/use-queue-requests';
import type { QueueTarget } from '@/types/queue';
import { QueueDetail } from './queue-detail';

/** Default the target from the topbar Local/EC2 toggle (localStorage). */
function readRuntimeTarget(): QueueTarget {
  if (typeof window === 'undefined') return 'ec2';
  const v = window.localStorage.getItem('futurator.labs.runtimeMode');
  return v === 'local' ? 'local' : 'ec2';
}

export function TestsTab() {
  const create = useCreateTestRequest();
  const [source, setSource] = useState('test');
  const [prompt, setPrompt] = useState('Say hello from the queue and report the current date.');
  // Lazy initializer mirrors runtime-controls.tsx — reads the topbar Local/EC2
  // toggle from localStorage once on mount (client-only; SSR guard returns 'ec2').
  const [target, setTarget] = useState<QueueTarget>(() => readRuntimeTarget());
  const [callbackUrl, setCallbackUrl] = useState('');
  const [autoRespond, setAutoRespond] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const submit = () => {
    create.mutate(
      {
        source: source.trim() || 'test',
        prompt: prompt.trim(),
        target,
        callbackUrl: callbackUrl.trim() || undefined,
        autoRespond,
      },
      { onSuccess: (res) => setActiveRequestId(res.requestId) },
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Compose call */}
      <div className="rounded-md border border-border p-4 space-y-3">
        <h3 className="text-sm font-medium">Compose test call</h3>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] uppercase text-muted-foreground">Source</span>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] uppercase text-muted-foreground">Target</span>
            <div className="flex rounded-md border border-input overflow-hidden">
              {(['ec2', 'local'] as QueueTarget[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTarget(t)}
                  className={`flex-1 px-2 py-1 text-xs ${
                    target === t
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">Prompt / instructions</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">
            Callback URL (optional)
          </span>
          <input
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            placeholder="https://…/webhook"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoRespond}
            onChange={(e) => setAutoRespond(e.target.checked)}
          />
          <span className="text-xs">
            Auto-respond <span className="text-muted-foreground">(default off)</span>
          </span>
        </label>

        <button
          onClick={submit}
          disabled={create.isPending || prompt.trim().length === 0}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {create.isPending ? 'Queuing…' : 'Send test call'}
        </button>
        {create.isError && (
          <p className="text-[10px] text-red-400">{(create.error as Error).message}</p>
        )}
      </div>

      {/* Live detail */}
      <div>
        {activeRequestId ? (
          <QueueDetail requestId={activeRequestId} />
        ) : (
          <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
            Send a test call to watch Claude execute it live.
          </div>
        )}
      </div>
    </div>
  );
}
