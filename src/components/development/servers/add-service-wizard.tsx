'use client';
import { useState } from 'react';
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
import { useProviderCatalog, useCreateServer } from '@/hooks/use-servers';
import type { ComputeProviderId, ServerServiceType, ProviderCatalogEntry } from '@/types/servers';

const MIN_CAP = 1;
const MAX_CAP = 16;
const DEFAULT_CAP = 2;

type WizardStep = 'provider' | 'service-type' | 'credentials' | 'confirm';

const STEP_LABEL: Record<WizardStep, string> = {
  provider: 'Provider',
  'service-type': 'Service type',
  credentials: 'Credentials',
  confirm: 'Shape & confirm',
};

interface HetznerForm {
  token: string;
}

interface OracleForm {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKeyPem: string;
  compartmentId: string;
  region: string;
  imageId: string;
  availabilityDomains: string; // comma-separated in the UI, split into an array on submit
}

interface GcpForm {
  serviceAccountJson: string;
  projectId: string;
  zone: string;
}

const EMPTY_HETZNER: HetznerForm = { token: '' };
const EMPTY_ORACLE: OracleForm = {
  tenancyOcid: '',
  userOcid: '',
  fingerprint: '',
  privateKeyPem: '',
  compartmentId: '',
  region: '',
  imageId: '',
  availabilityDomains: '',
};
const EMPTY_GCP: GcpForm = { serviceAccountJson: '', projectId: '', zone: '' };

const ORACLE_TEXT_FIELDS: Array<
  [keyof Omit<OracleForm, 'privateKeyPem' | 'availabilityDomains'>, string]
> = [
  ['tenancyOcid', 'Tenancy OCID'],
  ['userOcid', 'User OCID'],
  ['fingerprint', 'Key fingerprint'],
  ['compartmentId', 'Compartment OCID'],
  ['region', 'Region (e.g. eu-frankfurt-1)'],
  ['imageId', 'Image OCID'],
];

/**
 * 4-step Add Service wizard (Servers module, Task 22, spec §8):
 *   1. Provider    — catalog cards, each shows configured vs credentials-needed.
 *   2. Service type — catalog entries; `available: false` (Cloud Run Jobs)
 *      renders disabled with its "coming in v2" note, non-clickable.
 *   3. Credentials  — skipped when the provider is already configured, or
 *      when the service type is `local-machine` (nothing to store).
 *   4. Shape & confirm — region/size/arch/cap/cost, estimated monthly, then
 *      Provision. Local machines skip the cloud fields (region/size/cost are
 *      fixed) and end by showing the one-time install command instead of
 *      handing off to the Fleet tab immediately.
 */
export function AddServiceWizard({ onDone }: { onDone: () => void }) {
  const catalog = useProviderCatalog();
  const createServer = useCreateServer();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<WizardStep>('provider');
  const [provider, setProvider] = useState<ComputeProviderId | null>(null);
  const [serviceType, setServiceType] = useState<ServerServiceType | null>(null);

  const [hetznerForm, setHetznerForm] = useState<HetznerForm>(EMPTY_HETZNER);
  const [oracleForm, setOracleForm] = useState<OracleForm>(EMPTY_ORACLE);
  const [gcpForm, setGcpForm] = useState<GcpForm>(EMPTY_GCP);
  const [credentialsSubmitting, setCredentialsSubmitting] = useState(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [size, setSize] = useState('');
  const [arch, setArch] = useState<'arm64' | 'x86_64'>('arm64');
  const [maxConcurrent, setMaxConcurrent] = useState(DEFAULT_CAP);
  const [costPerHour, setCostPerHour] = useState(0);
  const [installCommand, setInstallCommand] = useState<string | undefined>(undefined);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const providers = catalog.data?.providers ?? [];
  const selectedEntry = providers.find((p) => p.provider === provider);
  const isLocal = serviceType === 'local-machine';

  function selectProvider(entry: ProviderCatalogEntry) {
    setProvider(entry.provider);
    setServiceType(null);
    setStep('service-type');
  }

  function selectServiceType(entry: ProviderCatalogEntry, type: ServerServiceType) {
    setServiceType(type);
    if (type === 'local-machine') {
      setRegion('local');
      setSize('local-machine');
      setCostPerHour(0);
      setStep('confirm');
      return;
    }
    setRegion(entry.defaultRegions[0] ?? '');
    setSize(entry.defaultSizes[0] ?? '');
    setStep(entry.configured ? 'confirm' : 'credentials');
  }

  const hetznerValid = hetznerForm.token.trim().length > 0;
  const oracleValid =
    oracleForm.tenancyOcid.trim() !== '' &&
    oracleForm.userOcid.trim() !== '' &&
    oracleForm.fingerprint.trim() !== '' &&
    oracleForm.privateKeyPem.trim() !== '' &&
    oracleForm.compartmentId.trim() !== '' &&
    oracleForm.region.trim() !== '' &&
    oracleForm.imageId.trim() !== '' &&
    oracleForm.availabilityDomains.trim() !== '';
  const gcpValid =
    gcpForm.serviceAccountJson.trim() !== '' &&
    gcpForm.projectId.trim() !== '' &&
    gcpForm.zone.trim() !== '';
  const credentialsValid =
    provider === 'hetzner' ? hetznerValid : provider === 'oracle' ? oracleValid : gcpValid;

  async function submitCredentials() {
    if (!provider) return;
    setCredentialsError(null);
    setCredentialsSubmitting(true);
    try {
      const credentials =
        provider === 'hetzner'
          ? hetznerForm
          : provider === 'oracle'
            ? {
                ...oracleForm,
                availabilityDomains: oracleForm.availabilityDomains
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : gcpForm;
      await api.post(`/servers/providers/${provider}/credentials`, credentials);
      await queryClient.invalidateQueries({ queryKey: ['servers', 'providers'] });
      setStep('confirm');
    } catch (err) {
      setCredentialsError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setCredentialsSubmitting(false);
    }
  }

  const confirmValid =
    name.trim().length > 0 && (isLocal || (region.trim() !== '' && size.trim() !== ''));

  async function provision() {
    if (!provider || !serviceType) return;
    setProvisionError(null);
    try {
      const result = await createServer.mutateAsync({
        name: name.trim(),
        provider,
        serviceType,
        region,
        size,
        arch,
        maxConcurrent,
        costPerHour,
      });
      if (result.installCommand) {
        setInstallCommand(result.installCommand);
      } else {
        onDone();
      }
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Failed to create server');
    }
  }

  function backFromConfirm() {
    if (isLocal) {
      setStep('service-type');
      return;
    }
    setStep(selectedEntry?.configured ? 'service-type' : 'credentials');
  }

  return (
    <div className="max-w-2xl space-y-4">
      <StepIndicator step={step} />

      {step === 'provider' && (
        <ProviderStep
          providers={providers}
          isLoading={catalog.isLoading}
          error={catalog.error as Error | null}
          onSelect={selectProvider}
        />
      )}

      {step === 'service-type' && selectedEntry && (
        <ServiceTypeStep
          entry={selectedEntry}
          onSelect={(type) => selectServiceType(selectedEntry, type)}
          onBack={() => setStep('provider')}
        />
      )}

      {step === 'credentials' && provider && (
        <CredentialsStep
          provider={provider}
          hetznerForm={hetznerForm}
          setHetznerForm={setHetznerForm}
          oracleForm={oracleForm}
          setOracleForm={setOracleForm}
          gcpForm={gcpForm}
          setGcpForm={setGcpForm}
          valid={credentialsValid}
          submitting={credentialsSubmitting}
          error={credentialsError}
          onSubmit={submitCredentials}
          onBack={() => setStep('service-type')}
        />
      )}

      {step === 'confirm' &&
        provider &&
        serviceType &&
        (installCommand ? (
          <InstallCommandResult command={installCommand} onDone={onDone} />
        ) : (
          <ConfirmStep
            entry={selectedEntry}
            isLocal={isLocal}
            name={name}
            setName={setName}
            region={region}
            setRegion={setRegion}
            size={size}
            setSize={setSize}
            arch={arch}
            setArch={setArch}
            maxConcurrent={maxConcurrent}
            setMaxConcurrent={setMaxConcurrent}
            costPerHour={costPerHour}
            setCostPerHour={setCostPerHour}
            valid={confirmValid}
            submitting={createServer.isPending}
            error={provisionError}
            onSubmit={provision}
            onBack={backFromConfirm}
          />
        ))}
    </div>
  );
}

function StepIndicator({ step }: { step: WizardStep }) {
  const steps: WizardStep[] = ['provider', 'service-type', 'credentials', 'confirm'];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {steps.map((s, i) => (
        <span
          key={s}
          className={cn('flex items-center gap-2', s === step && 'font-semibold text-foreground')}
        >
          {i > 0 && <span className="text-muted-foreground/50">→</span>}
          {STEP_LABEL[s]}
        </span>
      ))}
    </div>
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
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading providers…</p>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load providers: {error.message}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {providers.map((entry) => (
        <button
          key={entry.provider}
          type="button"
          onClick={() => onSelect(entry)}
          className="text-left"
        >
          <Card className="p-4 transition-colors hover:border-accent-blue/40 hover:bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{entry.label}</span>
              <Badge
                variant="outline"
                className={
                  entry.configured ? 'border-success text-success' : 'border-warning text-warning'
                }
              >
                {entry.configured ? 'Configured ✓' : 'Credentials needed'}
              </Badge>
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}

function ServiceTypeStep({
  entry,
  onSelect,
  onBack,
}: {
  entry: ProviderCatalogEntry;
  onSelect: (type: ServerServiceType) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {entry.serviceTypes.map((st) => (
          <button
            key={st.type}
            type="button"
            disabled={!st.available}
            onClick={() => st.available && onSelect(st.type)}
            className="text-left disabled:cursor-not-allowed"
          >
            <Card
              className={cn(
                'p-4 transition-colors',
                st.available ? 'hover:border-accent-blue/40 hover:bg-muted/30' : 'opacity-50',
              )}
            >
              <div className="text-sm font-semibold">{st.label}</div>
              {!st.available && st.note && (
                <p className="mt-1 text-xs text-muted-foreground">{st.note}</p>
              )}
            </Card>
          </button>
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}

function CredentialsStep(props: {
  provider: ComputeProviderId;
  hetznerForm: HetznerForm;
  setHetznerForm: (f: HetznerForm) => void;
  oracleForm: OracleForm;
  setOracleForm: (f: OracleForm) => void;
  gcpForm: GcpForm;
  setGcpForm: (f: GcpForm) => void;
  valid: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const {
    provider,
    hetznerForm,
    setHetznerForm,
    oracleForm,
    setOracleForm,
    gcpForm,
    setGcpForm,
    valid,
    submitting,
    error,
    onSubmit,
    onBack,
  } = props;

  return (
    <Card className="space-y-3 p-4">
      {provider === 'hetzner' && (
        <div className="space-y-1">
          <Label htmlFor="asw-hetzner-token">API token</Label>
          <Input
            id="asw-hetzner-token"
            type="password"
            autoComplete="off"
            value={hetznerForm.token}
            onChange={(e) => setHetznerForm({ token: e.target.value })}
            placeholder="Hetzner Cloud API token"
            className="font-mono text-sm"
          />
        </div>
      )}

      {provider === 'oracle' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ORACLE_TEXT_FIELDS.map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`asw-oracle-${key}`}>{label}</Label>
              <Input
                id={`asw-oracle-${key}`}
                value={oracleForm[key]}
                onChange={(e) => setOracleForm({ ...oracleForm, [key]: e.target.value })}
                className="font-mono text-sm"
              />
            </div>
          ))}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="asw-oracle-ads">Availability domains (comma-separated)</Label>
            <Input
              id="asw-oracle-ads"
              value={oracleForm.availabilityDomains}
              onChange={(e) =>
                setOracleForm({ ...oracleForm, availabilityDomains: e.target.value })
              }
              placeholder="AD-1, AD-2"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="asw-oracle-key">Private key (PEM)</Label>
            <Textarea
              id="asw-oracle-key"
              value={oracleForm.privateKeyPem}
              onChange={(e) => setOracleForm({ ...oracleForm, privateKeyPem: e.target.value })}
              placeholder="-----BEGIN PRIVATE KEY-----"
              className="font-mono text-xs"
              rows={5}
            />
          </div>
        </div>
      )}

      {provider === 'gcp' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="asw-gcp-sa">Service account JSON</Label>
            <Textarea
              id="asw-gcp-sa"
              value={gcpForm.serviceAccountJson}
              onChange={(e) => setGcpForm({ ...gcpForm, serviceAccountJson: e.target.value })}
              placeholder='{ "type": "service_account", ... }'
              className="font-mono text-xs"
              rows={6}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="asw-gcp-project">Project ID</Label>
              <Input
                id="asw-gcp-project"
                value={gcpForm.projectId}
                onChange={(e) => setGcpForm({ ...gcpForm, projectId: e.target.value })}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="asw-gcp-zone">Zone</Label>
              <Input
                id="asw-gcp-zone"
                value={gcpForm.zone}
                onChange={(e) => setGcpForm({ ...gcpForm, zone: e.target.value })}
                placeholder="europe-west3-a"
                className="font-mono text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!valid || submitting}>
          {submitting ? 'Saving…' : 'Save & continue'}
        </Button>
      </div>
    </Card>
  );
}

function ConfirmStep(props: {
  entry: ProviderCatalogEntry | undefined;
  isLocal: boolean;
  name: string;
  setName: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  size: string;
  setSize: (v: string) => void;
  arch: 'arm64' | 'x86_64';
  setArch: (v: 'arm64' | 'x86_64') => void;
  maxConcurrent: number;
  setMaxConcurrent: (v: number) => void;
  costPerHour: number;
  setCostPerHour: (v: number) => void;
  valid: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const {
    entry,
    isLocal,
    name,
    setName,
    region,
    setRegion,
    size,
    setSize,
    arch,
    setArch,
    maxConcurrent,
    setMaxConcurrent,
    costPerHour,
    setCostPerHour,
    valid,
    submitting,
    error,
    onSubmit,
    onBack,
  } = props;

  const regions = entry?.defaultRegions ?? [];
  const sizes = entry?.defaultSizes ?? [];
  const estimatedMonthly = costPerHour * 24 * 30;

  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-1">
        <Label htmlFor="asw-name">Server name</Label>
        <Input
          id="asw-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isLocal ? 'local-mac-2' : 'hetzner-fsn-2'}
          className="font-mono text-sm"
        />
      </div>

      {!isLocal && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Region</Label>
            {regions.length > 0 ? (
              <Select value={region} onValueChange={(v) => v && setRegion(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="font-mono text-sm"
                placeholder="region"
              />
            )}
          </div>
          <div className="space-y-1">
            <Label>Size</Label>
            {sizes.length > 0 ? (
              <Select value={size} onValueChange={(v) => v && setSize(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sizes.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="font-mono text-sm"
                placeholder="size"
              />
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>Architecture</Label>
          <Select value={arch} onValueChange={(v) => v && setArch(v as 'arm64' | 'x86_64')}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="arm64">arm64</SelectItem>
              <SelectItem value="x86_64">x86_64</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Max concurrent</Label>
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
            <span className="w-6 text-center font-mono text-xs tabular-nums">{maxConcurrent}</span>
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
        </div>
        {!isLocal && (
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
          </div>
        )}
      </div>

      {!isLocal && (
        <p className="text-xs text-muted-foreground">
          Estimated monthly cost: <span className="font-mono">${estimatedMonthly.toFixed(2)}</span>
        </p>
      )}

      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!valid || submitting}>
          {submitting ? 'Provisioning…' : 'Provision'}
        </Button>
      </div>
    </Card>
  );
}

function InstallCommandResult({ command, onDone }: { command: string; onDone: () => void }) {
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
        Server row created. Run this once on the target machine to enroll its daemon — shown only
        now:
      </p>
      <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2">
        <div className="break-all font-mono text-[11px] text-muted-foreground">{command}</div>
        <Button variant="outline" size="xs" onClick={copy}>
          {copied ? 'Copied!' : 'Copy install command'}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>
          Done — view fleet
        </Button>
      </div>
    </Card>
  );
}
