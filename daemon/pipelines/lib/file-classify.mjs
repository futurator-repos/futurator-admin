/**
 * file-classify.mjs — B2 (EU-migration File Explorer control-job lane).
 *
 * MIME/kind classifier for the daemon-side file-browse handler. Extracted
 * from the pre-migration `functions/api/index.ts` classifier (the SSM-backed
 * `/api/ec2/files/content` route, index.ts:7226-7311) so the daemon can
 * classify a file locally instead of the Lambda reaching over SSM.
 *
 * The table is intentionally DUPLICATED here rather than imported across the
 * daemon ↔ functions package boundary (per the B2 spec — duplicate table is
 * acceptable over a cross-package import). Keep the two tables in rough sync
 * if either grows; drift only changes which editor pane a file lands in.
 *
 * `kind` drives the frontend renderer:
 *   text   → CodeMirror / markdown / plain
 *   image  → <img> data URL
 *   pdf    → <embed>
 *   binary → download-only fallback
 */

// Hard cap for a single-file read. Bigger files come back with
// `tooLarge: true` so the frontend can offer a download instead of choking
// the browser. Mirrors the old `EC2_FILE_MAX_BYTES`.
export const FILE_MAX_BYTES = 2 * 1024 * 1024;

export const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'md', 'mdx', 'txt', 'log',
  'yaml', 'yml', 'toml', 'ini', 'env',
  'html', 'htm', 'xml', 'svg',
  'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh', 'fish',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'kt',
  'sql', 'graphql', 'gql',
  'gitignore', 'dockerignore', 'dockerfile', 'editorconfig', 'prettierrc',
]);

export const IMAGE_EXTS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  // image/vnd.microsoft.icon is the IANA-registered MIME and is decoded by
  // every modern browser when fed via blob URL. The legacy image/x-icon was
  // unreliable in Chrome data-URL flows.
  ico: 'image/vnd.microsoft.icon',
  // svg is intentionally classified as text so it lands in the code editor by
  // default; the viewer offers a Source/Preview toggle for it.
};

export const PDF_MIME = 'application/pdf';

/**
 * Classify a file by name. Returns `{ kind, mime }`.
 * @param {string} name basename (or full path; only the extension matters)
 * @returns {{ kind: 'text'|'image'|'pdf'|'binary', mime: string }}
 */
export function classifyFile(name) {
  const lower = String(name).toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : lower;
  if (ext === 'pdf') return { kind: 'pdf', mime: PDF_MIME };
  if (IMAGE_EXTS[ext]) return { kind: 'image', mime: IMAGE_EXTS[ext] };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', mime: 'text/plain' };
  // Files with no extension (LICENSE, README, Makefile, Dockerfile) are
  // overwhelmingly text — try them as text and let the frontend deal with
  // any decode failures.
  if (!lower.includes('.')) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'binary', mime: 'application/octet-stream' };
}
