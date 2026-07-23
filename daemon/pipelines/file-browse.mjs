/**
 * file-browse.mjs — B2 (EU-migration File Explorer control-job lane).
 *
 * Daemon-side handler for the `file-browse` control job. Replaces the old
 * SSM-backed `/api/ec2/files*` routes: the Lambda now enqueues a `file-browse`
 * job (B4) pinned to `assignedServerId` (B3); the daemon on that box lists or
 * reads a path on its LOCAL filesystem and writes a denormalized
 * `fileBrowseResult` back onto the job row. Works on Mac and EC2 alike — no
 * SSM, no instance-state gate.
 *
 * PATH SAFETY (the whole point of running this server-side): every browse is
 * confined to a server-scoped root (`FUTURATOR_BROWSE_ROOT`, defaulting to the
 * daemon user's home dir). We reject `..` segments and shell metacharacters up
 * front, then `path.resolve` + `startsWith(root)` to guarantee no path escapes
 * the root even via symlink-free tricks. Rejection happens BEFORE any
 * `readdir`/`readFile`, so a traversal attempt never touches the disk.
 */

import { readdirSync, statSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  classifyFile,
  FILE_MAX_BYTES,
} from './lib/file-classify.mjs';

// Shell metacharacters / control chars. We read via fs (not a shell) so this
// is defense-in-depth; combined with the `..`-segment reject and the
// root-containment check below it makes escape practically impossible.
const META_RE = /[\0\n\r;|&$`<>]/;

/**
 * The server-scoped browse root. Set `FUTURATOR_BROWSE_ROOT` per host; falls
 * back to the daemon user's home dir (on EC2 that resolves to `/home/ubuntu`,
 * matching the legacy hard root; on a Mac dev box it is the operator's home).
 */
export function resolveBrowseRoot() {
  return path.resolve(process.env.FUTURATOR_BROWSE_ROOT || os.homedir());
}

/**
 * Resolve `inputPath` against the browse root and prove it stays inside.
 * Empty/whitespace input defaults to the root itself. Throws on any
 * metachar, `..` segment, or root escape — without touching the filesystem.
 *
 * @param {string} inputPath raw path from the payload (absolute or relative)
 * @returns {{ root: string, target: string }} absolute, contained paths
 */
export function assertSafeBrowsePath(inputPath) {
  const root = resolveBrowseRoot();
  const raw = inputPath == null ? '' : String(inputPath);

  if (META_RE.test(raw)) {
    throw new Error(`file-browse: illegal characters in path`);
  }
  if (raw.split('/').includes('..')) {
    throw new Error(`file-browse: path traversal rejected`);
  }

  const target =
    raw.trim() === ''
      ? root
      : path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(root, raw);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`file-browse: path escapes browse root`);
  }
  return { root, target };
}

// Render a POSIX mode as an ls-style permission string, e.g. `drwxr-xr-x`.
// Mirrors the shape the old SSM `ls -lAp` path returned so the frontend's
// FileEntry.permissions rendering is unchanged.
function formatPermissions(stat) {
  const typeChar = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let out = typeChar;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (stat.mode >> shift) & 0b111;
    out += (triad & 0b100 ? bits[0] : '-') + (triad & 0b010 ? bits[1] : '-') + (triad & 0b001 ? bits[2] : '-');
  }
  return out;
}

// `YYYY-MM-DD HH:MM` in the daemon host's local time — matches the old
// `ls --time-style=long-iso` output (minus seconds).
function formatModified(mtime) {
  const d = new Date(mtime);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * List a directory. Directories first, then files, each alphabetical —
 * mirroring the old `ls -lAp --group-directories-first`. Dotfiles included,
 * `.`/`..` excluded. Unreadable entries are skipped rather than aborting the
 * whole listing.
 *
 * @param {string} absDir contained absolute directory path
 * @returns {Array<{name,type,size,permissions,modified}>}
 */
export function listDir(absDir) {
  const dirents = readdirSync(absDir, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    const full = path.join(absDir, dirent.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      // Dangling symlink or permission error — fall back to lstat so the
      // entry still shows, and never throw out of the whole listing.
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
    }
    entries.push({
      name: dirent.name,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      permissions: formatPermissions(st),
      modified: formatModified(st.mtime),
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Read a single file, size-capped and classified. Text is returned decoded
 * inline; image/pdf/binary as base64; anything over the 2 MB cap comes back as
 * a `tooLarge` marker so the frontend can offer a download instead.
 *
 * @param {string} absFile contained absolute file path
 * @returns {object} the `read`-op fields of `fileBrowseResult`
 */
export function readFileClassified(absFile) {
  const st = statSync(absFile);
  if (!st.isFile()) {
    throw new Error(`file-browse: not a regular file`);
  }
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs);
  const { kind, mime } = classifyFile(path.basename(absFile));

  if (size > FILE_MAX_BYTES) {
    return { kind, mime, size, mtime, tooLarge: true, maxBytes: FILE_MAX_BYTES };
  }

  const buf = readFileSync(absFile);
  // A NUL byte means the file is really binary even if the extension said
  // text — hand it back as base64 so the frontend offers a download instead
  // of rendering mojibake in the editor.
  if (kind === 'text' && !buf.includes(0)) {
    return { kind: 'text', mime, size, mtime, content: buf.toString('utf-8') };
  }
  if (kind === 'text') {
    return { kind: 'binary', mime: 'application/octet-stream', size, mtime, base64: buf.toString('base64') };
  }
  return { kind, mime, size, mtime, base64: buf.toString('base64') };
}

/**
 * Execute a `file-browse` payload and produce the `fileBrowseResult` object
 * (sans job status — the daemon dispatcher writes that). Pure w.r.t. the job
 * row; all it touches is the local filesystem under the browse root.
 *
 * @param {{ op: 'list'|'read', path: string, serverId?: string }} payload
 * @returns {NonNullable<import('../../functions/shared/types/agent-orchestrator').AgentJob['fileBrowseResult']>}
 */
export function runFileBrowse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('file-browse: missing payload');
  }
  const { op } = payload;
  if (op !== 'list' && op !== 'read') {
    throw new Error(`file-browse: unknown op "${op}"`);
  }

  const { target } = assertSafeBrowsePath(payload.path);

  if (op === 'list') {
    return { op: 'list', path: target, entries: listDir(target) };
  }
  return { op: 'read', path: target, ...readFileClassified(target) };
}
