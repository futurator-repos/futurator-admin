/**
 * Pipeline v2.0 PR-8g — resolve QA boilerplate context for a Plan.
 *
 * The qa-execute pipeline boots the deployed app's dev server in
 * qa-prepare. Each boilerplate has different defaults — Next.js boots
 * on :3000 with `--hostname`, Vite on :5173 with `--host`, SST on a
 * gateway port, Expo on :19006 (`expo start --web`). Without a
 * boilerplate-aware lookup, the QA stage falls back to Vite defaults
 * and breaks for every Next.js / SST / Expo App.
 *
 * `boilerplateType` lives on the App row (not the Plan) per the
 * App/Plan v1 migration. This resolver reads `plan.appId → app.boilerplateType`
 * and returns the matching `BOILERPLATE_REGISTRY[type].qaContext`.
 *
 * Returns `undefined` when:
 *   • `plan.appId` is absent (legacy pre-v1 plan)
 *   • the app row is missing
 *   • the app has no `boilerplateType` set (legacy bootstrap)
 *   • the boilerplate has no `qaContext` (only Phase-2 stubs declared today)
 *
 * Callers must treat undefined as "fall back to launcher defaults"
 * (Vite-flavored: :5173, `npm run dev -- --host 0.0.0.0 --port`, no warmup).
 * The fallback is fine for legacy Apps but wrong for new Next.js Apps —
 * which is why this resolver exists.
 */

import type { App } from '../types/app';
import type { Plan } from '../types/plan';
import type { BoilerplateMetadata } from '../boilerplates/types';
import { BOILERPLATE_REGISTRY, normalizeBoilerplateType } from '../boilerplates/registry';

export type QaContext = NonNullable<BoilerplateMetadata['qaContext']>;

export interface QaBoilerplateResolverDeps {
  getApp: (appId: string) => Promise<App | null>;
}

/**
 * Look up the qaContext for the App that owns this Plan. See module
 * docstring for fallback semantics.
 *
 * The Plan type technically does not declare `appId` (the field exists at
 * runtime via the App/Plan v1 migration but the type was never updated —
 * pre-existing tech debt). We read it via a defensive cast and return
 * `undefined` if absent.
 */
export async function resolveQaContext(
  plan: Plan,
  deps: QaBoilerplateResolverDeps,
): Promise<QaContext | undefined> {
  const appId = (plan as Plan & { appId?: string }).appId;
  if (!appId) return undefined;
  const app = await deps.getApp(appId);
  if (!app) return undefined;
  // PR-13 — App.boilerplateType includes the legacy 'nextjs' alias; the
  // registry only knows about the new keys. Normalize before indexing.
  const boilerplate = app.boilerplateType;
  if (!boilerplate) return undefined;
  const normalized = normalizeBoilerplateType(boilerplate);
  return BOILERPLATE_REGISTRY[normalized]?.qaContext;
}

/**
 * VQA v3 (E2/E4) — does the App's boilerplate ship a `window.__harness`
 * verifiability seam? Same App→boilerplateType lookup as `resolveQaContext`.
 * Drives qa-aggregate to route `state`/`behavior` ACs to the deterministic
 * L2-state oracle and to run the oracle-strength coverage check. Returns
 * `false` for legacy plans / seam-less boilerplates (the safe default).
 */
export async function resolveHasSeam(
  plan: Plan,
  deps: QaBoilerplateResolverDeps,
): Promise<boolean> {
  const appId = (plan as Plan & { appId?: string }).appId;
  if (!appId) return false;
  const app = await deps.getApp(appId);
  if (!app?.boilerplateType) return false;
  const normalized = normalizeBoilerplateType(app.boilerplateType);
  return !!BOILERPLATE_REGISTRY[normalized]?.testHarness;
}
