/**
 * boilerplate-registry-client-view.ts — Pipeline v2 / Story 1.4.1.
 *
 * Slim client-safe view of `functions/shared/boilerplates/registry.ts`. Only
 * the display + pickability metadata leaks to the browser; the full registry
 * stays server-side because it imports server-only modules transitively (PAT
 * loader, AWS SDK).
 *
 * Adding a new boilerplate type means updating BOTH this file and the
 * server registry. The shape is intentionally minimal — anything the modal
 * doesn't render lives only on the server.
 */

import type { BoilerplateType } from '@/types/app';

export interface BoilerplateClientView {
  type: BoilerplateType;
  displayName: string;
  icon: string;
  /**
   * `'wired'` types ship a real scaffold; `'stub'` types are real GitHub
   * template repos but only contain a README. The picker still lets the
   * operator click stubs (with a "Phase X" badge) so the saga code path
   * is exercised end-to-end.
   */
  status: 'wired' | 'stub';
  /** Whether the BMAD pre-install toggle should appear when this type is picked. */
  bmadSupported: boolean;
  /** Human-readable hint shown under stub options. Omitted for `'wired'`. */
  stubHint?: string;
  /**
   * PR-13 — domain taxonomy + tagline shown in the dropdown so operators
   * pick a starter pack matching their intent. `general` is the fallback
   * (`nextjs-base`).
   */
  domain?: 'general' | 'game' | 'form' | 'dashboard' | 'ecommerce' | 'api';
  tagline?: string;
}

export const BOILERPLATE_CLIENT_VIEW: BoilerplateClientView[] = [
  {
    type: 'nextjs-base',
    displayName: 'Next.js (base)',
    icon: '⚛️',
    status: 'wired',
    bmadSupported: true,
    domain: 'general',
    tagline: 'Generic Next.js scaffold — pick when no specific starter fits.',
  },
  {
    type: 'nextjs-canvas-game',
    displayName: 'Next.js — Canvas2D Game',
    icon: '🎮',
    status: 'wired',
    bmadSupported: true,
    domain: 'game',
    tagline:
      'Pre-baked game loop, keyboard hook, physics + state machine. Best for arcade-style 2D games.',
  },
  {
    type: 'nextjs-form-app',
    displayName: 'Next.js — Form-driven App',
    icon: '📝',
    status: 'stub',
    bmadSupported: true,
    domain: 'form',
    tagline: 'react-hook-form + zod + multi-step wizard pattern.',
    stubHint: 'Phase 2 — augment files pending',
  },
  {
    type: 'nextjs-dashboard',
    displayName: 'Next.js — Dashboard',
    icon: '📊',
    status: 'stub',
    bmadSupported: true,
    domain: 'dashboard',
    tagline: 'Recharts + tanstack-table + URL-state filters.',
    stubHint: 'Phase 2 — augment files pending',
  },
  {
    type: 'sst',
    displayName: 'SST',
    icon: '☁️',
    status: 'stub',
    bmadSupported: false,
    domain: 'api',
    stubHint: 'Phase 2 — scaffold pending',
  },
  {
    type: 'vite',
    displayName: 'Vite + React',
    icon: '⚡',
    status: 'stub',
    bmadSupported: false,
    domain: 'general',
    stubHint: 'Phase 2 — scaffold pending',
  },
  {
    type: 'mobile',
    displayName: 'Expo Mobile',
    icon: '📱',
    status: 'stub',
    bmadSupported: false,
    domain: 'general',
    stubHint: 'Phase 3 — scaffold pending',
  },
];

/**
 * PR-13 — backward-compat shim for legacy `boilerplateType: 'nextjs'` rows.
 * Mirrors `normalizeBoilerplateType` from the server registry.
 */
function normalize(type: BoilerplateType): BoilerplateType {
  return (type as string) === 'nextjs' ? 'nextjs-base' : type;
}

export function getBoilerplateClientView(type: BoilerplateType): BoilerplateClientView {
  const normalized = normalize(type);
  const view = BOILERPLATE_CLIENT_VIEW.find((v) => v.type === normalized);
  if (!view) throw new Error(`unknown boilerplate type: ${type}`);
  return view;
}
