'use client';

/**
 * WiringOrphanBanner — QA-Review W2 wiring check.
 *
 * A deterministic gate the assemble step must pass: every runtime module it
 * produces must have at least one importer. Zero importers means the
 * assemble step generated dead code and never wired it in — the exact class
 * of bug pacman3 shipped (ghost-ai.ts / reducer.ts / controls.ts sat in the
 * repo, fully authored, never imported by anything that ran).
 *
 * Presentational only — the report comes via props (WiringReport, see
 * `@/types/qa-review-p3`). Red + visible when `orphanModules.length > 0`;
 * renders nothing at 0 (a clean wiring check earns no real estate).
 *
 * Reuses the shared QA primitives (`./qa-primitives`) for the banner/badge
 * chrome so it stays visually consistent with the other W2 panels, and
 * mirrors the `integrityHeadline` shape from `@/lib/graph-insights` (the
 * Graph tab's orphan-invariant headline) for the pure-helper pattern.
 */

import { Banner, StatusChip } from './qa-primitives';
import type { WiringReport } from '@/types/qa-review-p3';

// ── Pure helper (exported + unit-tested) ─────────────────────────────

export type WiringTone = 'pass' | 'fail';

export interface WiringHeadline {
  tone: WiringTone;
  label: string;
  detail: string;
}

/**
 * The wiring-invariant headline for a WiringReport, mirroring
 * `integrityHeadline` (graph-insights.ts) — `pass` when there are no
 * orphaned modules, `fail` (always, regardless of `blocking`) when there
 * are one or more, since an orphan module is a real finding either way.
 */
export function wiringHeadline(wiring: WiringReport | null | undefined): WiringHeadline {
  const count = wiring?.orphanModules.length ?? 0;
  if (count === 0) {
    return {
      tone: 'pass',
      label: 'Wiring: no orphan modules',
      detail: 'every assembled runtime module has at least one importer',
    };
  }
  return {
    tone: 'fail',
    label: `Wiring: ${count} orphan module${count === 1 ? '' : 's'}`,
    detail: wiring?.blocking
      ? 'the assemble step left runtime module(s) with 0 importers — dead code that blocks the QA verdict (the pacman3 ghost-module class)'
      : 'the assemble step left runtime module(s) with 0 importers — dead code (advisory)',
  };
}

// ── Component ─────────────────────────────────────────────────────────

export interface WiringOrphanBannerProps {
  wiring: WiringReport | null | undefined;
}

export function WiringOrphanBanner({ wiring }: WiringOrphanBannerProps) {
  const orphanModules = wiring?.orphanModules ?? [];

  // Hidden at 0 — a clean wiring check doesn't need to occupy space.
  if (orphanModules.length === 0) return null;

  const headline = wiringHeadline(wiring);

  return (
    <div
      data-testid="wiring-orphan-banner"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <Banner color="var(--destructive)">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusChip status="fail" />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--foreground)',
            }}
          >
            {headline.label}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{headline.detail}</span>
        </div>
      </Banner>

      <ul
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          margin: 0,
          padding: 0,
          listStyle: 'none',
        }}
      >
        {orphanModules.map((mod) => (
          <li
            key={mod}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 5,
              border: '1px solid color-mix(in srgb, var(--destructive) 35%, transparent)',
              background: 'color-mix(in srgb, var(--destructive) 6%, transparent)',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--destructive)',
                flexShrink: 0,
              }}
            />
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--text-dim)',
                wordBreak: 'break-all',
              }}
            >
              {mod}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}
