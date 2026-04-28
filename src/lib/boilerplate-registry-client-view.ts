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
}

export const BOILERPLATE_CLIENT_VIEW: BoilerplateClientView[] = [
  {
    type: 'nextjs',
    displayName: 'Next.js + BMAD',
    icon: '⚛️',
    status: 'wired',
    bmadSupported: true,
  },
  {
    type: 'sst',
    displayName: 'SST',
    icon: '☁️',
    status: 'stub',
    bmadSupported: false,
    stubHint: 'Phase 2 — scaffold pending',
  },
  {
    type: 'vite',
    displayName: 'Vite + React',
    icon: '⚡',
    status: 'stub',
    bmadSupported: false,
    stubHint: 'Phase 2 — scaffold pending',
  },
  {
    type: 'mobile',
    displayName: 'Expo Mobile',
    icon: '📱',
    status: 'stub',
    bmadSupported: false,
    stubHint: 'Phase 3 — scaffold pending',
  },
];

export function getBoilerplateClientView(type: BoilerplateType): BoilerplateClientView {
  const view = BOILERPLATE_CLIENT_VIEW.find((v) => v.type === type);
  if (!view) throw new Error(`unknown boilerplate type: ${type}`);
  return view;
}
