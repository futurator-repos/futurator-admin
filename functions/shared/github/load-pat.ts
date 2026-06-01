/**
 * load-pat.ts — Story 1.1.2 (Pipeline v2 Phase 1)
 *
 * Provides the GitHub Personal Access Token (PAT) to callers in both
 * SST-runtime (Lambda/production) and local-dev contexts.
 *
 * SST runtime:  reads from SSM via Resource.GithubPat.value (linked secret).
 * Local dev:    reads from process.env.GITHUB_PAT (set in .env.local).
 *
 * NEVER log or return the PAT value directly. Callers should only use the
 * token in Authorization headers and treat it as opaque.
 *
 * The @ts-expect-error below is intentional: Resource.GithubPat is absent
 * from sst-env.d.ts until the first `sst deploy` after the secret is declared.
 * At runtime the SST connector resolves the value from SSM Parameter Store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 2026-05-30 — per-request PAT override. The default `loadPat()` returns the
 * `futurator-repos`-scoped GithubPat, which cannot read brownfield repos in
 * OTHER orgs (e.g. Get-Really-Real/applicator → 404). For those, the API
 * resolves the brownfield PAT and wraps the connector calls in `runWithPat`,
 * so every `loadPat()` inside that async scope returns the override instead.
 * AsyncLocalStorage keeps it request-isolated under Lambda concurrency — no
 * threading a `pat` param through every connector function.
 */
const patStore = new AsyncLocalStorage<string>();

/** Run `fn` with `pat` as the active PAT for all `loadPat()` calls inside it. */
export function runWithPat<T>(pat: string, fn: () => T): T {
  return patStore.run(pat, fn);
}

export function loadPat(): string {
  // Per-request override (brownfield, any org) wins when set.
  const override = patStore.getStore();
  if (override) return override;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resource } = require('sst') as { Resource: Record<string, { value: string }> };
    return Resource['GithubPat'].value;
  } catch {
    const envPat = process.env.GITHUB_PAT;
    if (!envPat)
      throw new Error(
        'GitHub PAT not available — set GITHUB_PAT in .env.local for local dev, or run `sst secret set GithubPat <value>` for SST deploys',
      );
    return envPat;
  }
}
