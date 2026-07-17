'use client';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProviderCatalog, useCreateServer, useServers } from '@/hooks/use-servers';
import type {
  ComputeProviderId,
  ServerServiceType,
  ProviderCatalogEntry,
  ProviderCredentialField,
  ProviderSizeOption,
} from '@/types/servers';

const MIN_CAP = 1;
const MAX_CAP = 16;

type Step = 'provider' | 'service-type' | 'credentials' | 'shape' | 'done';

/**
 * Add Server wizard (Servers module — spec §8).
 *
 * Every option it offers is driven by the provider catalog the backend
 * validates against, so the wizard cannot walk the operator into a request the
 * provisioner will reject:
 *  - providers with no adapter (AWS/EC2 = IaC) render disabled with the reason;
 *  - the service-type step only appears where there is a real choice (GCP);
 *  - shapes carry their arch and price, so architecture is derived (never a
 *    contradictory free choice) and cost/hr is pre-filled (a 0 would tell the
 *    cheapest-first dispatch policy that a paid box is free);
 *  - for Oracle/GCP — whose adapters place every VM by the stored credentials —
 *    the location is shown, not asked.
 */
export function AddServerWizard({ onClose }: { onClose: () => void }) {
  const catalog = useProviderCatalog();
  const { data: fleet } = useServers();
  const createServer = useCreateServer();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('provider');
  const [entry, setEntry] = useState<ProviderCatalogEntry | null>(null);
  const [serviceType, setServiceType] = useState<ServerServiceType | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [size, setSize] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [costPerHour, setCostPerHour] = useState(0);
  const [installCommand, setInstallCommand] = useState<string | null>(null);

  const providers = catalog.data?.providers ?? [];
  const servers = useMemo(() => fleet?.servers ?? [], [fleet]);
  const selectedSize: ProviderSizeOption | undefined = entry?.sizes.find((s) => s.value === size);
  const isLocal = serviceType === 'local-machine';

  /** Oracle/GCP: the credentials' own region/zone. Fresh input wins over the stored echo. */
  const credentialPlacement =
    entry?.regionSource === 'credentials'
      ? (credentials.zone ?? credentials.region ?? entry.placement?.zone ?? entry.placement?.region)
      : undefined;

  function suggestName(provider: ComputeProviderId): string {
    const n = servers.filter((s) => s.provider === provider).length + 1;
    return `${provider}-${n}`;
  }

  function pickProvider(e: ProviderCatalogEntry) {
    setEntry(e);
    setError(null);
    setCredentials({});
    setName(suggestName(e.provider));
    setMaxConcurrent(e.defaultMaxConcurrent);
    const firstSize = e.sizes[0];
    setSize(firstSize?.value ?? (e.provider === 'local' ? 'local-machine' : ''));
    setCostPerHour(firstSize?.costPerHour ?? 0);
    setRegion(e.regionSource === 'server' ? (e.regions[0]?.value ?? '') : '');

    const available = e.serviceTypes.filter((s) => s.available);
    // Only ask when there is an actual choice — a lone "Virtual machine" card
    // is a click that decides nothing.
    if (available.length === 1) {
      advanceFromServiceType(e, available[0].type);
      return;
    }
    setStep('service-type');
  }

  function advanceFromServiceType(e: ProviderCatalogEntry, type: ServerServiceType) {
    setServiceType(type);
    setStep(!e.requiresCredentials || e.configured ? 'shape' : 'credentials');
  }

  function pickSize(value: string) {
    setSize(value);
    const s = entry?.sizes.find((x) => x.value === value);
    if (s) setCostPerHour(s.costPerHour);
  }

  const credentialsValid = (entry?.credentialFields ?? []).every(
    (f) => (credentials[f.name] ?? '').trim().length > 0,
  );

  async function saveCredentials() {
    if (!entry) return;
    setError(null);
    setCredentialsBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const field of entry.credentialFields) {
        const raw = (credentials[field.name] ?? '').trim();
        payload[field.name] =
          field.kind === 'list'
            ? raw
                .split(/[\n,]/)
                .map((s) => s.trim())
                .filter(Boolean)
            : raw;
      }
      await api.post(`/servers/providers/${entry.provider}/credentials`, payload);
      await queryClient.invalidateQueries({ queryKey: ['servers', 'providers'] });
      setStep('shape');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setCredentialsBusy(false);
    }
  }

  const shapeValid =
    name.trim().length > 0 &&
    (isLocal || (size.trim() !== '' && (entry?.regionSource !== 'server' || region.trim() !== '')));

  async function provision() {
    if (!entry || !serviceType) return;
    setError(null);
    try {
      const result = await createServer.mutateAsync({
        name: name.trim(),
        provider: entry.provider,
        serviceType,
        // The backend resolves the authoritative region for credential-placed
        // providers; send what we know so the request is self-describing.
        region: isLocal ? 'local' : (credentialPlacement ?? region),
        size: isLocal ? 'local-machine' : size,
        arch: selectedSize?.arch ?? 'arm64',
        maxConcurrent,
        costPerHour,
      });
      if (result.installCommand) {
        setInstallCommand(result.installCommand);
        setStep('done');
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
    }
  }

  function back() {
    setError(null);
    if (step === 'shape') {
      const available = entry?.serviceTypes.filter((s) => s.available) ?? [];
      if (entry?.requiresCredentials && !entry.configured) setStep('credentials');
      else setStep(available.length > 1 ? 'service-type' : 'provider');
      return;
    }
    if (step === 'credentials') {
      const available = entry?.serviceTypes.filter((s) => s.available) ?? [];
      setStep(available.length > 1 ? 'service-type' : 'provider');
      return;
    }
    setStep('provider');
  }

  return (
    <div className="space-y-4">
      {step !== 'done' && <Steps step={step} entry={entry} />}

      {step === 'provider' && (
        <ProviderStep
          providers={providers}
          isLoading={catalog.isLoading}
          error={catalog.error as Error | null}
          onSelect={pickProvider}
        />
      )}

      {step === 'service-type' && entry && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {entry.serviceTypes.map((st) => (
              <OptionCard
                key={st.type}
                title={st.label}
                note={st.note}
                disabled={!st.available}
                onClick={() => advanceFromServiceType(entry, st.type)}
              />
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={back}>
            Back
          </Button>
        </div>
      )}

      {step === 'credentials' && entry && (
        <CredentialsStep
          entry={entry}
          values={credentials}
          onChange={(name_, value) => setCredentials((c) => ({ ...c, [name_]: value }))}
          valid={credentialsValid}
          busy={credentialsBusy}
          error={error}
          onSubmit={saveCredentials}
          onBack={back}
        />
      )}

      {step === 'shape' && entry && (
        <ShapeStep
          entry={entry}
          isLocal={isLocal}
          name={name}
          setName={setName}
          region={region}
          setRegion={setRegion}
          credentialPlacement={credentialPlacement}
          size={size}
          setSize={pickSize}
          selectedSize={selectedSize}
          maxConcurrent={maxConcurrent}
          setMaxConcurrent={setMaxConcurrent}
          costPerHour={costPerHour}
          setCostPerHour={setCostPerHour}
          valid={shapeValid}
          busy={createServer.isPending}
          error={error}
          onSubmit={provision}
          onBack={back}
          onReplaceCredentials={() => setStep('credentials')}
        />
      )}

      {step === 'done' && installCommand && (
        <InstallCommandResult command={installCommand} onClose={onClose} />
      )}
    </div>
  );
}

function Steps({ step, entry }: { step: Step; entry: ProviderCatalogEntry | null }) {
  const showServiceType = (entry?.serviceTypes.filter((s) => s.available).length ?? 0) > 1;
  const showCredentials = !!entry?.requiresCredentials && !entry.configured;
  const items: Array<[Step, string]> = [
    ['provider', 'Provider'],
    ...((showServiceType ? [['service-type', 'Service']] : []) as Array<[Step, string]>),
    ...((showCredentials ? [['credentials', 'Credentials']] : []) as Array<[Step, string]>),
    ['shape', entry?.provider === 'local' ? 'Details' : 'Shape & confirm'],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {items.map(([s, label], i) => (
        <span
          key={s}
          className={cn('flex items-center gap-2', s === step && 'font-semibold text-foreground')}
        >
          {i > 0 && <span className="text-muted-foreground/50">→</span>}
          {label}
        </span>
      ))}
    </div>
  );
}

function OptionCard({
  title,
  subtitle,
  note,
  badge,
  disabled,
  onClick,
}: {
  title: string;
  subtitle?: string;
  note?: string;
  badge?: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="text-left disabled:cursor-not-allowed"
    >
      <Card
        className={cn(
          'h-full p-4 transition-colors',
          disabled ? 'opacity-60' : 'hover:border-accent-blue/40 hover:bg-muted/30',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {badge}
        </div>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
        {note && <p className="mt-1.5 text-xs text-warning">{note}</p>}
      </Card>
    </button>
  );
}

function ProviderStep({
  providers,
  isLoading,
  error,
  onSelect,
}: {
  providers: ProviderCatalogEntry[];
  isLoading: boolean;
  error: Error | null;
  onSelect: (entry: ProviderCatalogEntry) => void;
}) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading providers…</p>;
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load providers: {error.message}
      </div>
    );
  }
  const creatable = providers.filter((p) => p.creatable);
  const rest = providers.filter((p) => !p.creatable);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {creatable.map((entry) => (
          <OptionCard
            key={entry.provider}
            title={entry.label}
            subtitle={entry.summary}
            badge={
              !entry.requiresCredentials ? null : entry.configured ? (
                <Badge variant="outline" className="border-success text-success">
                  Configured ✓
                </Badge>
              ) : (
                <Badge variant="outline" className="border-warning text-warning">
                  Credentials needed
                </Badge>
              )
            }
            onClick={() => onSelect(entry)}
          />
        ))}
      </div>
      {rest.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rest.map((entry) => (
            <OptionCard
              key={entry.provider}
              title={entry.label}
              subtitle={entry.summary}
              note={entry.unavailableNote}
              disabled
              onClick={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CredentialField({
  field,
  value,
  onChange,
}: {
  field: ProviderCredentialField;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `cred-${field.name}`;
  const wide = field.kind === 'textarea' || field.kind === 'list';
  return (
    <div className={cn('space-y-1', wide && 'sm:col-span-2')}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.kind === 'textarea' || field.kind === 'list' ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="font-mono text-xs"
          rows={field.kind === 'list' ? 3 : 5}
        />
      ) : (
        <Input
          id={id}
          type={field.kind === 'password' ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="font-mono text-sm"
        />
      )}
      {field.help && <p className="text-[11px] leading-snug text-muted-foreground">{field.help}</p>}
    </div>
  );
}

function CredentialsStep({
  entry,
  values,
  onChange,
  valid,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  entry: ProviderCatalogEntry;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  valid: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <Card className="space-y-4 p-4">
      <div>
        <p className="text-sm font-semibold">{entry.label} credentials</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Stored write-only in Secrets Manager and never shown again.
          {entry.credentialsHelpUrl && (
            <>
              {' '}
              <a
                href={entry.credentialsHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                Open console ↗
              </a>
            </>
          )}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {entry.credentialFields.map((field) => (
          <CredentialField
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            onChange={(v) => onChange(field.name, v)}
          />
        ))}
      </div>
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!valid || busy}>
          {busy ? 'Saving…' : 'Save & continue'}
        </Button>
      </div>
    </Card>
  );
}

function ShapeStep(props: {
  entry: ProviderCatalogEntry;
  isLocal: boolean;
  name: string;
  setName: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  credentialPlacement?: string;
  size: string;
  setSize: (v: string) => void;
  selectedSize?: ProviderSizeOption;
  maxConcurrent: number;
  setMaxConcurrent: (v: number) => void;
  costPerHour: number;
  setCostPerHour: (v: number) => void;
  valid: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
  onReplaceCredentials: () => void;
}) {
  const {
    entry,
    isLocal,
    name,
    setName,
    region,
    setRegion,
    credentialPlacement,
    size,
    setSize,
    selectedSize,
    maxConcurrent,
    setMaxConcurrent,
    costPerHour,
    setCostPerHour,
    valid,
    busy,
    error,
    onSubmit,
    onBack,
    onReplaceCredentials,
  } = props;

  const monthly = costPerHour * 24 * 30;

  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-1">
        <Label htmlFor="asw-name">Server name</Label>
        <Input
          id="asw-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          How this box appears in the fleet, the dispatch policy, and assignment reasons.
        </p>
      </div>

      {!isLocal && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Location</Label>
              {entry.regionSource === 'server' ? (
                <Select value={region} onValueChange={(v) => v && setRegion(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {entry.regions.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="font-mono text-sm">{credentialPlacement ?? '—'}</span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Fixed by your {entry.label} credentials.{' '}
                    <button
                      type="button"
                      onClick={onReplaceCredentials}
                      className="underline hover:text-foreground"
                    >
                      Change
                    </button>
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label>Max concurrent jobs</Label>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="icon-xs"
                  disabled={maxConcurrent <= MIN_CAP}
                  onClick={() => setMaxConcurrent(Math.max(MIN_CAP, maxConcurrent - 1))}
                  aria-label="Decrease cap"
                >
                  −
                </Button>
                <span className="w-6 text-center font-mono text-xs tabular-nums">
                  {maxConcurrent}
                </span>
                <Button
                  variant="outline"
                  size="icon-xs"
                  disabled={maxConcurrent >= MAX_CAP}
                  onClick={() => setMaxConcurrent(Math.min(MAX_CAP, maxConcurrent + 1))}
                  aria-label="Increase cap"
                >
                  +
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The dispatcher never sends this box more than this at once.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Shape</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {entry.sizes.map((s) => (
                <button key={s.value} type="button" onClick={() => setSize(s.value)}>
                  <Card
                    className={cn(
                      'h-full p-3 text-left transition-colors',
                      s.value === size
                        ? 'border-accent-blue bg-accent-blue/5'
                        : 'hover:border-accent-blue/40 hover:bg-muted/30',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold">{s.label}</span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {s.arch}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {s.vcpu} vCPU · {s.memGB} GB ·{' '}
                      {s.costPerHour === 0 ? 'free' : `$${s.costPerHour}/hr`}
                    </p>
                    {s.note && <p className="mt-1 text-[11px] text-muted-foreground">{s.note}</p>}
                  </Card>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="asw-cost">Cost / hr (USD)</Label>
              <Input
                id="asw-cost"
                type="number"
                min={0}
                step="0.001"
                value={costPerHour}
                onChange={(e) => setCostPerHour(Number(e.target.value) || 0)}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Estimated from the shape — correct it if your plan differs. Cheapest-first dispatch
                ranks by this number.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Estimated monthly</Label>
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                ${monthly.toFixed(2)}
              </div>
              {selectedSize && (
                <p className="text-[11px] text-muted-foreground">
                  Architecture {selectedSize.arch}, set by the shape.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {isLocal && (
        <p className="text-xs text-muted-foreground">
          You&apos;ll get a one-time install command to run on that machine — it enrolls the daemon
          and starts polling for its assigned jobs.
        </p>
      )}

      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!valid || busy}>
          {busy ? 'Provisioning…' : isLocal ? 'Create' : 'Provision'}
        </Button>
      </div>
    </Card>
  );
}

function InstallCommandResult({ command, onClose }: { command: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm">
        Server created. Run this once on that machine to enroll its daemon — the token is shown only
        now:
      </p>
      <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2">
        <div className="break-all font-mono text-[11px] text-muted-foreground">{command}</div>
        <Button variant="outline" size="xs" onClick={copy}>
          {copied ? 'Copied!' : 'Copy install command'}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={onClose}>
          Done — view fleet
        </Button>
      </div>
    </Card>
  );
}
