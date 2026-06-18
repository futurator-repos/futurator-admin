/**
 * icons.ts — per-kind glyphs rendered onto the graph canvas.
 *
 * Each icon is a lucide-style 24×24 stroke path, rasterized to a cached
 * HTMLImageElement (one variant per stroke colour) so `ctx.drawImage` is cheap
 * on every frame. Ported from the v0 reference; icon keys come from KIND_META.
 */

const ICON_PATHS: Record<string, string> = {
  // file — page with folded corner
  file: '<path d="M14 3v5h5"/><path d="M6 3h8l5 5v13H6z"/>',
  // function — ƒ braces
  function:
    '<path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/>',
  // class — cube
  class: '<path d="M12 2 2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  // dir — folder
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // decision — lightbulb
  decision:
    '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  // system — boxes / cpu
  system:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  // requirement — checklist
  requirement:
    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  // document — lines on a page
  document: '<path d="M14 3v5h5"/><path d="M6 3h8l5 5v13H6z"/><path d="M9 13h6M9 17h6M9 9h2"/>',
};

const iconCache = new Map<string, HTMLImageElement>();

/** Cached, colour-tinted icon image for canvas drawing; null on SSR / unknown. */
export function getIconImage(iconKey: string, color = '#ffffff'): HTMLImageElement | null {
  if (typeof window === 'undefined') return null;
  const key = `${iconKey}|${color}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const inner = ICON_PATHS[iconKey];
  if (!inner) return null;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  iconCache.set(key, img);
  return img;
}
