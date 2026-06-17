'use client';

/**
 * /labs/skills/growth-inbox — Skills Institution, Story 3.3 + 3.4.
 *
 * The curation Inbox: a code-review-style queue where the operator triages skill
 * proposals on the gist, then decides on the diff. This is the human Phase-2
 * synthesis step — the only path a skill reaches `trusted`. Proposals arrive from
 * the reflector loop (graduate), manual create/paste-url, or bulk acquisition.
 *
 * Keyboard model: j/k move, Enter opens, a=ratify, x=reject, d=defer, r=refresh.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useSkillProposals,
  useSkillProposalDetail,
  useProposalDecision,
  useSubmitToGate,
  type SkillProposal,
  type ProposalStatus,
  type SecurityStatus,
  type TrustTier,
} from '@/hooks/use-skill-proposals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const STATUS_TABS: ProposalStatus[] = [
  'pending',
  'quarantined',
  'ratified',
  'rejected',
  'deferred',
];

function SecurityBadge({ status }: { status: SecurityStatus }) {
  const map: Record<
    SecurityStatus,
    { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
  > = {
    clean: { variant: 'secondary', label: 'clean' },
    flagged: { variant: 'outline', label: 'flagged' },
    quarantined: { variant: 'destructive', label: 'quarantined' },
    unverified: { variant: 'outline', label: 'unverified' },
  };
  const m = map[status] ?? map.unverified;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function TrustBadge({ tier }: { tier?: TrustTier }) {
  const map: Record<TrustTier, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    trusted: 'default',
    reviewed: 'secondary',
    draft: 'outline',
    deprecated: 'destructive',
  };
  return <Badge variant={tier ? map[tier] : 'outline'}>{tier ?? 'draft'}</Badge>;
}

export default function GrowthInboxPage() {
  const [status, setStatus] = useState<ProposalStatus>('pending');
  const { data, isLoading, refetch } = useSkillProposals(status);
  const proposals = useMemo(() => data?.proposals ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const decision = useProposalDecision();

  // Derive a safe cursor (no clamp-in-effect) — the stored cursor may exceed the
  // current list length after a refetch, so clamp at read time.
  const safeCursor = proposals.length === 0 ? 0 : Math.min(cursor, proposals.length - 1);

  const act = useCallback(
    (id: string, d: 'ratify' | 'reject' | 'defer', override?: boolean) => {
      decision.mutate({ id, decision: d, override }, { onSuccess: () => setSelectedId(null) });
    },
    [decision],
  );

  // Keyboard navigation — disabled while a dialog is open or typing in a field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (addOpen || selectedId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const cur = proposals[safeCursor];
      switch (e.key) {
        case 'j':
          setCursor(Math.min(proposals.length - 1, safeCursor + 1));
          break;
        case 'k':
          setCursor(Math.max(0, safeCursor - 1));
          break;
        case 'Enter':
          if (cur) setSelectedId(cur.proposalId);
          break;
        case 'a':
          if (cur && cur.status !== 'quarantined') act(cur.proposalId, 'ratify');
          break;
        case 'x':
          if (cur) act(cur.proposalId, 'reject');
          break;
        case 'd':
          if (cur) act(cur.proposalId, 'defer');
          break;
        case 'r':
          refetch();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [proposals, safeCursor, selectedId, addOpen, act, refetch]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_TABS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === status ? 'default' : 'outline'}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          + Add skill
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Triage on the gist, decide on the diff. Keys: <kbd>j</kbd>/<kbd>k</kbd> move,{' '}
        <kbd>Enter</kbd> open, <kbd>a</kbd> ratify, <kbd>x</kbd> reject, <kbd>d</kbd> defer,{' '}
        <kbd>r</kbd> refresh. Ratify is the only path to <strong>trusted</strong>.
      </p>

      {isLoading && <p className="text-sm text-muted-foreground">Loading proposals…</p>}
      {!isLoading && proposals.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No <strong>{status}</strong> proposals. The reflector loop, manual adds, and bulk
          acquisition all land here.
        </p>
      )}

      <div className="rounded-lg border divide-y">
        {proposals.map((p, i) => (
          <ProposalRow
            key={p.proposalId}
            proposal={p}
            active={i === safeCursor}
            onClick={() => {
              setCursor(i);
              setSelectedId(p.proposalId);
            }}
          />
        ))}
      </div>

      {selectedId && (
        <ProposalDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onAct={act}
          pending={decision.isPending}
        />
      )}

      <AddSkillDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function ProposalRow({
  proposal,
  active,
  onClick,
}: {
  proposal: SkillProposal;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 ${
        active ? 'bg-muted/60 ring-1 ring-inset ring-ring/40' : ''
      }`}
    >
      <code className="text-sm font-medium shrink-0">{proposal.skillName}</code>
      <span className="text-xs text-muted-foreground truncate flex-1">{proposal.gist}</span>
      <Badge variant="outline" className="shrink-0">
        {proposal.source}
      </Badge>
      <SecurityBadge status={proposal.securityStatus} />
      <TrustBadge tier={proposal.proposedEntry.trustTier} />
    </button>
  );
}

function ProposalDrawer({
  id,
  onClose,
  onAct,
  pending,
}: {
  id: string;
  onClose: () => void;
  onAct: (id: string, d: 'ratify' | 'reject' | 'defer', override?: boolean) => void;
  pending: boolean;
}) {
  const { data, isLoading } = useSkillProposalDetail(id);
  const p = data?.proposal;
  const quarantined = p?.status === 'quarantined';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <code>{p?.skillName ?? id}</code>
            {p && <SecurityBadge status={p.securityStatus} />}
            {p && <TrustBadge tier={p.proposedEntry.trustTier} />}
          </DialogTitle>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {p && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{p.gist}</p>

            {p.scanReport && p.scanReport.patternsHit.length > 0 && (
              <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
                <p className="font-medium text-destructive mb-1">Gate-1 findings</p>
                <ul className="space-y-0.5">
                  {p.scanReport.patternsHit.map((h, i) => (
                    <li key={i} className="font-mono text-xs">
                      <span className={h.severity === 'blocking' ? 'text-destructive' : ''}>
                        [{h.severity}] {h.id}
                      </span>{' '}
                      — {h.evidence} <span className="text-muted-foreground">({h.location})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <SkillDiffViewer diff={data?.diff} />
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            size="sm"
            disabled={pending || !p}
            onClick={() => {
              if (!p) return;
              if (quarantined) {
                if (confirmOverride()) onAct(p.proposalId, 'ratify', true);
              } else {
                onAct(p.proposalId, 'ratify');
              }
            }}
          >
            {quarantined ? 'Ratify (override quarantine)' : 'Ratify → trusted'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !p}
            onClick={() => p && onAct(p.proposalId, 'defer')}
          >
            Defer
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending || !p}
            onClick={() => p && onAct(p.proposalId, 'reject')}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Explicit override confirmation for ratifying a quarantined proposal. */
function confirmOverride(): boolean {
  return window.confirm(
    'This proposal was QUARANTINED by Gate-1 (a blocking security pattern). ' +
      'Ratifying it publishes the skill as "flagged". Are you sure?',
  );
}

function SkillDiffViewer({ diff }: { diff?: { lines: { type: string; text: string }[] } }) {
  if (!diff) return null;
  return (
    <pre className="rounded border bg-muted/30 p-2 text-xs overflow-x-auto leading-relaxed">
      {diff.lines.map((l, i) => (
        <div
          key={i}
          className={
            l.type === 'add'
              ? 'bg-success/15 text-success-foreground'
              : l.type === 'del'
                ? 'bg-destructive/10 text-destructive'
                : ''
          }
        >
          <span className="select-none opacity-60">
            {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
          </span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function AddSkillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'create' | 'paste-url'>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const submit = useSubmitToGate();

  const reset = () => {
    setName('');
    setDescription('');
    setBody('');
    setSourceUrl('');
    submit.reset();
  };

  const onSubmit = () => {
    submit.mutate(
      {
        mode,
        name,
        description,
        body: mode === 'create' ? body : undefined,
        sourceUrl: mode === 'paste-url' ? sourceUrl : undefined,
      },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a skill (through the gate)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {(['create', 'paste-url'] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={m === mode ? 'default' : 'outline'}
                onClick={() => setMode(m)}
              >
                {m === 'create' ? 'Write it' : 'Paste URL'}
              </Button>
            ))}
          </div>
          <Input
            placeholder="skill-name (lowercase-slug)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder="One-line description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {mode === 'create' ? (
            <Textarea
              placeholder="SKILL.md body (markdown)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
            />
          ) : (
            <Input
              placeholder="https://… (a SKILL.md or skill page)"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          )}
          <p className="text-xs text-muted-foreground">
            It lands in the inbox as a <strong>draft</strong> proposal after Gate-1 — it becomes
            installable only once you ratify it.
          </p>
          {submit.isError && (
            <p className="text-xs text-destructive">
              {(submit.error as Error)?.message ?? 'Submission failed.'}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submit.isPending || !name || !description}>
            Submit to gate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
