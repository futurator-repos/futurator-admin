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

export function loadPat(): string {
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
