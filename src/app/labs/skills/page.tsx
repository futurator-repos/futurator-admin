'use client';
/**
 * /labs/skills — the Skill Registry (now the primary Skills tab, 2026-06-16).
 *
 * Browse + search every skill across the federation (GET /api/skills/catalog),
 * select a skill to view its full metadata AND its SKILL.md body (lazily fetched
 * via GET /api/skills/:name), full CRUD on operator-authored skills, and — given
 * ?appId= — the on-disk ↔ federation drift (GET /api/skills/reconciliation).
 *
 * AuthGuard / AppShell / tab bar / Suspense are provided by the shared layout.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSkillCatalog, useSkill, type CatalogSkill } from '@/hooks/use-skill-catalog';
import { useSkillReconciliation } from '@/hooks/use-skill-reconciliation';
import { useCreateSkill, useUpdateSkill, useDeleteSkill } from '@/hooks/use-skill-mutations';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

function FrameworkBadge({ framework }: { framework: boolean }) {
  return (
    <Badge variant={framework ? 'secondary' : 'outline'} className="font-mono">
      {framework ? 'bmad' : 'skill'}
    </Badge>
  );
}

// Curation-facet badges (Story 4.3). Facets may be absent on an old cached
// response → migrated defaults are applied server-side, but guard here too.
function TrustBadge({ tier }: { tier?: CatalogSkill['trustTier'] }) {
  const t = tier ?? 'draft';
  const variant =
    t === 'trusted'
      ? 'default'
      : t === 'reviewed'
        ? 'secondary'
        : t === 'deprecated'
          ? 'destructive'
          : 'outline';
  return <Badge variant={variant}>{t}</Badge>;
}

function SecurityBadge({ status }: { status?: CatalogSkill['securityStatus'] }) {
  const s = status ?? 'unverified';
  if (s === 'clean') return null; // clean is the unremarkable default — don't clutter rows
  const variant = s === 'quarantined' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{s}</Badge>;
}

function SkillDetail({
  skill,
  onClose,
  onEdit,
  onDelete,
}: {
  skill: CatalogSkill;
  onClose: () => void;
  onEdit: (s: CatalogSkill) => void;
  onDelete: (s: CatalogSkill) => void;
}) {
  // Lazily fetch the full body only for the selected skill.
  const { data, isLoading } = useSkill(skill.name);
  const readonly = data?.frameworkReadonly ?? skill.framework;

  return (
    <Card size="sm" className="sticky top-4 self-start">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="font-mono">{skill.name}</CardTitle>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <FrameworkBadge framework={skill.framework} />
          <span className="text-xs text-muted-foreground">
            {skill.kind} · {skill.license}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed">{skill.description || '— no description —'}</p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">source</dt>
          <dd>
            {skill.source} {skill.autoTrust && <span className="text-success">· auto-trust</span>}
          </dd>
          <dt className="text-muted-foreground">version</dt>
          <dd>{skill.version}</dd>
          <dt className="text-muted-foreground">trust</dt>
          <dd>{skill.trustTier ?? 'draft'}</dd>
          <dt className="text-muted-foreground">security</dt>
          <dd
            className={
              skill.securityStatus === 'quarantined'
                ? 'text-destructive'
                : skill.securityStatus === 'flagged'
                  ? 'text-warning'
                  : undefined
            }
          >
            {skill.securityStatus ?? 'unverified'}
          </dd>
          <dt className="text-muted-foreground">provenance</dt>
          <dd>{skill.provenanceClass ?? '—'}</dd>
        </dl>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">SKILL.md body</Label>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : data?.body ? (
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 font-mono text-xs whitespace-pre-wrap">
              {data.body}
            </pre>
          ) : (
            <p className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              {readonly ? 'No editable body — sourced upstream.' : 'No body on file.'}
            </p>
          )}
        </div>

        {readonly ? (
          <p className="text-xs text-muted-foreground">
            bmad framework skill — sourced from bmad-method, not editable here.
          </p>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onEdit(skill)}>
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onDelete(skill)}>
              Delete
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Create/edit form in a Dialog. `editing` null = create mode; otherwise prefill + lock name. */
function SkillForm({
  editing,
  open,
  onClose,
}: {
  editing: CatalogSkill | null;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const isEdit = editing !== null;

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [kind, setKind] = useState(editing?.kind ?? 'core');
  const [license, setLicense] = useState(editing?.license ?? 'MIT');
  const [body, setBody] = useState('');

  // On edit, lazily fetch + prefill the existing body — ONCE, and only while the
  // field is still empty, so we never clobber operator edits on a refetch.
  const { data: detail } = useSkill(isEdit ? editing!.name : null);
  useEffect(() => {
    if (isEdit && detail?.body && body === '') {
      setBody(detail.body);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.body, isEdit]);

  const busy = create.isPending || update.isPending;
  const err = (create.error || update.error) as Error | null;
  const canSubmit =
    !busy &&
    description.trim().length > 0 &&
    body.trim().length > 0 &&
    (isEdit || name.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    const input = { name: name.trim(), description: description.trim(), kind, license, body };
    if (isEdit) update.mutate(input, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${editing!.name}` : 'New skill'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!isEdit && (
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">name (slug)</Label>
              <Input
                id="skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                autoComplete="off"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="skill-description">description</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="skill-kind">kind</Label>
              <Input id="skill-kind" value={kind} onChange={(e) => setKind(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-license">license</Label>
              <Input
                id="skill-license"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-body">SKILL.md body</Label>
            <Textarea
              id="skill-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder={'# My Skill\n\nInstructions for the agent…'}
              className="font-mono text-xs"
            />
          </div>

          {err && <p className="text-sm text-destructive">{err.message}</p>}
          <p className="text-xs text-muted-foreground">
            commits to futurator-repos/futurator-skills
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create skill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DriftPanel({ appId }: { appId: string }) {
  const { data, isLoading, error } = useSkillReconciliation(appId);
  if (isLoading) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (error || !data) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        Drift unavailable for {appId}.
      </div>
    );
  }
  const chip = (label: string, n: number, className: string) => (
    <span className={cn('font-mono text-xs', className)}>
      {label} <strong>{n}</strong>
    </span>
  );
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-4">
        <strong className="text-sm">Drift · {appId}</strong>
        {data.inSync ? (
          <span className="text-xs text-success">✓ in sync</span>
        ) : (
          <span className="text-xs text-warning">⚠ {data.unmanaged.length} unmanaged</span>
        )}
        {chip('on-disk', data.onDiskCount, 'text-muted-foreground')}
        {chip('managed', data.managed.length, 'text-success')}
        {chip('unmanaged', data.unmanaged.length, 'text-warning')}
        {chip('not-loaded', data.availableNotLoaded.length, 'text-muted-foreground')}
      </div>
      {data.unmanaged.length > 0 && (
        <p className="font-mono text-xs text-warning">unmanaged: {data.unmanaged.join(', ')}</p>
      )}
    </div>
  );
}

export default function SkillsRegistryPage() {
  const params = useSearchParams();
  const appId = params.get('appId') || undefined;
  const { data, isLoading, error } = useSkillCatalog();
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'bmad' | 'skill'>('all');
  const [trustFilter, setTrustFilter] = useState('all');
  const [selected, setSelected] = useState<CatalogSkill | null>(null);
  const [editing, setEditing] = useState<CatalogSkill | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const del = useDeleteSkill();

  const handleDelete = (s: CatalogSkill) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete skill "${s.name}"? This commits a removal to the source repo.`)
    ) {
      return;
    }
    del.mutate(s.name, { onSuccess: () => setSelected(null) });
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (s: CatalogSkill) => {
    setEditing(s);
    setFormOpen(true);
    setSelected(null);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const sources = useMemo(() => [...new Set((data?.skills ?? []).map((s) => s.source))], [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.skills ?? []).filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false;
      if (frameworkFilter === 'bmad' && !s.framework) return false;
      if (frameworkFilter === 'skill' && s.framework) return false;
      if (trustFilter !== 'all' && (s.trustTier ?? 'draft') !== trustFilter) return false;
      if (
        needle &&
        !s.name.toLowerCase().includes(needle) &&
        !s.description.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [data, q, sourceFilter, frameworkFilter, trustFilter]);

  const failedSources = data?.sources?.filter((s) => !s.ok).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-page-title">Skill Registry</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isLoading
              ? 'Loading catalog…'
              : error
                ? 'Failed to load catalog.'
                : `${data?.skills.length ?? 0} skills across ${sources.length} source(s)`}
            {failedSources > 0 && (
              <span className="text-warning"> · {failedSources} source(s) failed</span>
            )}
          </p>
        </div>
        <Button onClick={openCreate}>+ New skill</Button>
      </div>

      {appId && <DriftPanel appId={appId} />}

      {/* key forces a fresh mount per open/target so the lazy useState seeds +
          body prefill re-run for the current skill (no stale carry-over). */}
      {formOpen && (
        <SkillForm key={editing?.name ?? '__new__'} editing={editing} open onClose={closeForm} />
      )}

      <div className="flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or description…"
          className="max-w-xs flex-1"
        />
        <Select value={sourceFilter} onValueChange={(v) => v && setSourceFilter(v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all sources</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={frameworkFilter}
          onValueChange={(v) => v && setFrameworkFilter(v as 'all' | 'bmad' | 'skill')}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all kinds</SelectItem>
            <SelectItem value="bmad">bmad only</SelectItem>
            <SelectItem value="skill">non-bmad only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={trustFilter} onValueChange={(v) => v && setTrustFilter(v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all trust</SelectItem>
            <SelectItem value="trusted">trusted (installable)</SelectItem>
            <SelectItem value="reviewed">reviewed</SelectItem>
            <SelectItem value="draft">draft</SelectItem>
            <SelectItem value="deprecated">deprecated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        className={cn(
          'grid items-start gap-4',
          selected ? 'lg:grid-cols-[1fr_360px]' : 'grid-cols-1',
        )}
      >
        <div className="rounded-lg border border-border bg-card">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No skills match.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Trust</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>License</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow
                    key={`${s.name}@${s.source}`}
                    onClick={() => setSelected(s)}
                    className={cn('cursor-pointer', selected?.name === s.name && 'bg-muted/50')}
                  >
                    <TableCell>
                      <div className="font-mono text-sm">{s.name}</div>
                      <div className="max-w-sm truncate text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    </TableCell>
                    <TableCell>
                      <FrameworkBadge framework={s.framework} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <TrustBadge tier={s.trustTier} />
                        <SecurityBadge status={s.securityStatus} />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.source}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'font-mono text-xs',
                        s.license === 'UNKNOWN' ? 'text-warning' : 'text-muted-foreground',
                      )}
                    >
                      {s.license}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {selected && (
          <SkillDetail
            skill={selected}
            onClose={() => setSelected(null)}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}
