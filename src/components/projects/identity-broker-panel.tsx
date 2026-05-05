'use client';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  useIdentityBrokerApp,
  useIdentityBrokerDrift,
  useRegisterIdentityBrokerApp,
  useRotateIdentityBrokerApp,
  type DriftReport,
  type IdentityBrokerApp,
  type RegisterAppResult,
  type RotateAppResult,
} from '@/hooks/use-identity-broker';

type Env = 'prod' | 'dev';

const ENV_LABELS: Record<Env, string> = { prod: 'Production', dev: 'Development' };

/**
 * Canonical app-id convention going forward: `{projectId}-{env}`. For a
 * handful of legacy registrations (`futurator-admin`, `contento`, etc.)
 * the bare name still exists — we surface it only if the env-scoped
 * record is missing, to nudge operators toward the new convention
 * without breaking the existing state.
 */
function scopedAppId(projectId: string, env: Env): string {
  return `${projectId}-${env}`;
}

export function IdentityBrokerPanel({
  projectId,
  projectName,
  legacyAppIdFallback,
}: {
  projectId: string;
  projectName: string;
  /** Bare-name registration to fall back to when env-scoped lookup is empty. */
  legacyAppIdFallback?: string;
}) {
  const [env, setEnv] = useState<Env>('prod');

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border">
        {(['prod', 'dev'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEnv(e)}
            className={`px-3 py-1 text-sm ${
              env === e
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            } ${e === 'prod' ? 'rounded-l-md' : 'rounded-r-md'}`}
          >
            {ENV_LABELS[e]}
          </button>
        ))}
      </div>
      <EnvPanel
        env={env}
        projectId={projectId}
        projectName={projectName}
        legacyAppIdFallback={env === 'prod' ? legacyAppIdFallback : undefined}
      />
    </div>
  );
}

function EnvPanel({
  env,
  projectId,
  projectName,
  legacyAppIdFallback,
}: {
  env: Env;
  projectId: string;
  projectName: string;
  legacyAppIdFallback?: string;
}) {
  const scoped = scopedAppId(projectId, env);
  const scopedLookup = useIdentityBrokerApp(scoped);
  const legacyLookup = useIdentityBrokerApp(
    !scopedLookup.isLoading && scopedLookup.data && !scopedLookup.data.registered && legacyAppIdFallback
      ? legacyAppIdFallback
      : null,
  );
  const [justRegistered, setJustRegistered] = useState<RegisterAppResult | null>(null);
  const [justRotated, setJustRotated] = useState<RotateAppResult | null>(null);

  // Priority order: post-action ephemeral panels win.
  if (justRegistered) {
    return <PostRegisterResult result={justRegistered} onDismiss={() => setJustRegistered(null)} />;
  }
  if (justRotated) {
    return <PostRotateResult result={justRotated} onDismiss={() => setJustRotated(null)} />;
  }

  if (scopedLookup.isLoading || legacyLookup.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading broker config…</p>;
  }

  if (scopedLookup.error) {
    return <ErrorCallout appId={scoped} error={scopedLookup.error} />;
  }

  // Env-scoped record wins when present.
  if (scopedLookup.data?.registered) {
    return (
      <RegisteredView
        appId={scoped}
        env={env}
        app={scopedLookup.data.app}
        onRotated={setJustRotated}
      />
    );
  }

  // Fall back to a legacy bare-name registration (only for prod tab).
  if (legacyLookup.data?.registered) {
    return (
      <LegacyRegistrationBanner
        legacyAppId={legacyAppIdFallback!}
        scopedAppId={scoped}
        app={legacyLookup.data.app}
      />
    );
  }

  return (
    <RegisterForm
      env={env}
      appId={scoped}
      projectId={projectId}
      projectName={projectName}
      onRegistered={setJustRegistered}
    />
  );
}

function ErrorCallout({ appId, error }: { appId: string; error: unknown }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      Failed to load broker config for <code className="rounded bg-muted px-1">{appId}</code>:{' '}
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

function DriftBadge({ appId }: { appId: string }) {
  const { data, isLoading } = useIdentityBrokerDrift(appId);
  if (isLoading || !data) return null;
  const label: Record<DriftReport['status'], string> = {
    in_sync: 'In sync',
    drift: 'DRIFT',
    no_local_secret: 'No local secret',
    broker_missing: 'Broker missing',
  };
  const tone: Record<DriftReport['status'], string> = {
    in_sync: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/40',
    drift: 'bg-red-500/15 text-red-500 border-red-500/40',
    no_local_secret: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
    broker_missing: 'bg-muted text-muted-foreground border-muted',
  };
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${tone[data.status]}`}>
      {label[data.status]}
    </span>
  );
}

function RegisteredView({
  appId,
  env,
  app,
  onRotated,
}: {
  appId: string;
  env: Env;
  app: IdentityBrokerApp;
  onRotated: (r: RotateAppResult) => void;
}) {
  const rotate = useRotateIdentityBrokerApp(appId);
  const drift = useIdentityBrokerDrift(appId);

  const secretName = drift.data?.secretName ?? `futurator/${appId}/broker-credentials`;
  const inOverlap =
    !!app.previousSecretExpiresAt &&
    new Date(app.previousSecretExpiresAt).getTime() > Date.now();

  const cdkSnippet = `// In the ${app.name} repo's CDK / SST config:
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

const brokerCreds = Secret.fromSecretNameV2(
  this,
  'BrokerCreds',
  '${secretName}',
);
// Then pass brokerCreds.secretValueFromJson('clientId') / 'clientSecret'
// to the consuming Lambda's environment, OR read at runtime via
// @aws-sdk/client-secrets-manager.`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Registered</Badge>
        <Badge variant="outline">{ENV_LABELS[env]}</Badge>
        <DriftBadge appId={appId} />
        {inOverlap && (
          <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
            Rotation in progress (overlap until{' '}
            {new Date(app.previousSecretExpiresAt!).toLocaleString()})
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div className="col-span-2">
          <dt className="text-muted-foreground">App name (broker)</dt>
          <dd className="mt-0.5">
            {app.name} <span className="text-xs text-muted-foreground">({app.type})</span>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">App ID</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{app.appId}</code>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Client ID fingerprint</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{app.clientIdFingerprint}</code>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="mt-0.5">{new Date(app.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Secret updated</dt>
          <dd className="mt-0.5">
            {app.secretUpdatedAt ? new Date(app.secretUpdatedAt).toLocaleString() : '—'}
          </dd>
        </div>
      </dl>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Secrets Manager</h4>
        <p className="mb-2 text-xs text-muted-foreground">
          The clientSecret lives here — humans never touch it. The app's CDK imports by name.
        </p>
        <code className="block rounded bg-muted px-2 py-1 text-xs">{secretName}</code>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Redirect URIs</h4>
        <p className="mb-2 text-xs text-muted-foreground">
          The first URI is the default OAuth callback target — production should be first.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {app.redirectUris.map((uri, i) => (
            <li key={uri} className={i === 0 ? 'font-medium' : ''}>
              <code className="rounded bg-muted px-1">{uri}</code>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Allowed origins (CORS)</h4>
        <ul className="space-y-1 text-sm">
          {app.allowedOrigins.map((origin) => (
            <li key={origin}>
              <code className="rounded bg-muted px-1">{origin}</code>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Wire the app's CDK to this secret</h4>
        <pre className="overflow-auto rounded-md border bg-muted p-3 text-xs">{cdkSnippet}</pre>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(cdkSnippet)}
          className="mt-2 rounded-md border px-3 py-1 text-xs hover:bg-accent"
        >
          Copy CDK snippet
        </button>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <h4 className="mb-1 text-sm font-semibold">Rotate client secret</h4>
        <p className="mb-3 text-sm text-muted-foreground">
          Generates a fresh secret and writes it to Secrets Manager. The broker keeps the old
          secret valid for 1 hour so consumer Lambdas pick up the new value on natural cold
          starts — no coordinated redeploy needed.
        </p>
        <button
          type="button"
          disabled={rotate.isPending}
          onClick={async () => {
            if (!confirm(`Rotate secret for ${appId}?\n\nOld secret stays valid for 1h.`)) return;
            const res = await rotate.mutateAsync();
            onRotated(res);
          }}
          className="rounded-md bg-amber-500/90 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {rotate.isPending ? 'Rotating…' : 'Rotate secret now'}
        </button>
        {rotate.isError && (
          <p className="mt-2 text-sm text-destructive">
            {rotate.error instanceof Error ? rotate.error.message : 'Rotation failed'}
          </p>
        )}
      </div>
    </div>
  );
}

function LegacyRegistrationBanner({
  legacyAppId,
  scopedAppId,
  app,
}: {
  legacyAppId: string;
  scopedAppId: string;
  app: IdentityBrokerApp;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="outline">Legacy naming</Badge>
        </div>
        <p className="font-medium">
          This project is registered as{' '}
          <code className="rounded bg-muted px-1">{legacyAppId}</code> — the new convention
          is <code className="rounded bg-muted px-1">{scopedAppId}</code>.
        </p>
        <p className="mt-2 text-muted-foreground">
          Migration is a dual-register + cutover: register at the new id, redeploy the app
          pointing at the new Secrets Manager entry, then delete the legacy record. Delete is
          a Phase 3 action — for now just flagging. The legacy registration still works.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Legacy App ID</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{app.appId}</code>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Client ID fingerprint</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{app.clientIdFingerprint}</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function RegisterForm({
  env,
  appId,
  projectId,
  projectName,
  onRegistered,
}: {
  env: Env;
  appId: string;
  projectId: string;
  projectName: string;
  onRegistered: (r: RegisterAppResult) => void;
}) {
  const [name, setName] = useState(projectName);
  const defaultBaseUrl =
    env === 'prod' ? `https://${projectId}.futurator.ai` : `https://dev.${projectId}.futurator.ai`;
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const register = useRegisterIdentityBrokerApp(appId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Not registered</Badge>
        <span className="text-sm text-muted-foreground">
          No app with id <code className="rounded bg-muted px-1">{appId}</code> in the broker.
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        Registers the app with the Identity Broker. On success the generated{' '}
        <code className="rounded bg-muted px-1">clientSecret</code> is written directly to AWS
        Secrets Manager — it's never shown to you, and no env block needs to travel through a
        laptop.
      </p>

      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await register.mutateAsync({ name, baseUrl });
          onRegistered(result);
        }}
      >
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="ib-name">
            App name
          </label>
          <input
            id="ib-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="ib-baseurl">
            Base URL ({env})
          </label>
          <input
            id="ib-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://yourapp.futurator.ai"
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Broker auto-generates redirectUris + allowedOrigins from this URL. localhost is
            added only for dev.
          </p>
        </div>
        <button
          type="submit"
          disabled={register.isPending || !name}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {register.isPending ? 'Registering…' : `Register ${appId}`}
        </button>
        {register.isError && (
          <p className="text-sm text-destructive">
            {register.error instanceof Error ? register.error.message : 'Registration failed'}
          </p>
        )}
      </form>
    </div>
  );
}

function PostRegisterResult({
  result,
  onDismiss,
}: {
  result: RegisterAppResult;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Registered</Badge>
        {result.secretWritten ? (
          <span className="text-sm text-muted-foreground">
            clientSecret written to Secrets Manager.
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            App pre-existed — no new secret issued.
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div className="col-span-2">
          <dt className="text-muted-foreground">App ID</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.appId}</code>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Client ID fingerprint</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.clientIdFingerprint}</code>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Secrets Manager</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.secretName}</code>
          </dd>
        </div>
      </dl>

      <div className="rounded-lg border p-4">
        <h4 className="mb-2 text-sm font-semibold">
          Hand-off to the {result.config.name} team
        </h4>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            In the app's CDK/SST config, import the secret by name:
            <pre className="mt-1 overflow-auto rounded-md border bg-muted p-2 text-xs">
              {`Secret.fromSecretNameV2(this, 'BrokerCreds', '${result.secretName}')`}
            </pre>
            Then expose its JSON fields (<code>clientId</code>, <code>clientSecret</code>,
            <code>brokerUrl</code>, <code>jwksUrl</code>, <code>jwtIssuer</code>) to the
            consuming Lambda's environment. No plaintext secret ever lands on a laptop.
          </li>
          <li>
            Delete any hardcoded broker URLs. Search the repo for{' '}
            <code>vnfmz85xj1.execute-api</code> and <code>uyocidd3ll.execute-api</code>;
            replace with <code>brokerUrl</code> from the Secrets Manager payload.
          </li>
          <li>
            Verify JWT validation uses <code>jwtIssuer</code> (<code>{`https://api.futurator.com/v1`}</code>),{' '}
            <strong>not</strong> the broker URL — this catches every team at least once.
          </li>
          <li>
            Redeploy. Consumer Lambdas pick up the Secrets Manager value on the next cold
            start; no coordinated fleet action needed.
          </li>
          <li>
            Smoke test in incognito: the Google consent screen must say{' '}
            <strong>Ir a futurator.ai</strong>.
          </li>
          <li>
            Reference: <code>docs/identity-broker-quick-guide.md</code> in the{' '}
            <code>futurator-core</code> repo.
          </li>
        </ol>
      </div>

      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Done
      </button>
    </div>
  );
}

function PostRotateResult({
  result,
  onDismiss,
}: {
  result: RotateAppResult;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Rotated</Badge>
        <span className="text-sm text-muted-foreground">
          New secret written to Secrets Manager.
        </span>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <p className="font-medium">
          Previous secret is still valid until{' '}
          <strong>{new Date(result.previousSecretExpiresAt).toLocaleString()}</strong>.
        </p>
        <p className="mt-2 text-muted-foreground">
          Consumer Lambdas will pick up the new secret on their next cold start (Lambda
          runtime caches Secrets Manager values for up to ~5 min by default, up to the
          invocation-scope TTL you've set). No coordinated redeploy needed within the 1-hour
          overlap. After that window, old secret stops working.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div className="col-span-2">
          <dt className="text-muted-foreground">App ID</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.appId}</code>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">New client ID fingerprint</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.clientIdFingerprint}</code>
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Secrets Manager</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-muted px-1">{result.secretName}</code>
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Done
      </button>
    </div>
  );
}
