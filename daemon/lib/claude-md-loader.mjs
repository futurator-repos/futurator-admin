/**
 * claude-md-loader.mjs — Pipeline v2 Phase 3 / Story 3-E-4-1 (PR-80).
 *
 * Reads the project's CLAUDE.md from its working tree and exposes the
 * helpers the daemon's agent-spawn loop uses to prepend it to every
 * agent session's system prompt. Per v2.5 §41.3:
 *
 *   Daemon reads CLAUDE.md at session start → prepends to system prompt
 *   Context pack (Phase 2-A.2) is appended after CLAUDE.md
 *
 * CLAUDE.md is the narrative (why); the context pack is the substrate
 * (what). The order matters — agents see the why before they see the
 * file tree.
 *
 * Migration: file-backed today; Phase G ports to MA Memory Store with
 * the same surface (`read(scope, file)` from memory-store.mjs is the
 * sibling that handles `/mnt/memory/project-<slug>/CLAUDE.md` symlinks).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';

const MAX_SIZE_BYTES = 100 * 1024; // 100KB safety cap

/**
 * Read CLAUDE.md from the project working tree. Returns `null` when
 * missing or oversized; oversized returns a synthetic "truncated"
 * marker so the agent sees that the document existed but wasn't loaded.
 *
 * @param {string} workingDir absolute path to the project tree
 * @returns {{ content: string, sha: string, sizeBytes: number, truncated: boolean } | null}
 */
export function readClaudeMd(workingDir) {
  const path = join(workingDir, 'CLAUDE.md');
  if (!existsSync(path)) return null;
  let sizeBytes;
  try {
    sizeBytes = statSync(path).size;
  } catch {
    return null;
  }
  if (sizeBytes > MAX_SIZE_BYTES) {
    return {
      content: `<!-- CLAUDE.md truncated by daemon: ${sizeBytes} bytes exceeds ${MAX_SIZE_BYTES} cap -->\n`,
      sha: '',
      sizeBytes,
      truncated: true,
    };
  }
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { content, sha, sizeBytes, truncated: false };
}

/**
 * Compose an agent's full system prompt. v2.5 §41.3:
 *
 *   <CLAUDE.md content>
 *   <context pack content>
 *   <role-specific system prompt>
 *
 * Each section is separated by a blank line. CLAUDE.md is omitted when
 * the project doesn't have one yet (first commit before PR-80 augments
 * landed, or brownfield project pre-3-F audit).
 *
 * @param {{
 *   workingDir: string,
 *   contextPack?: string,
 *   rolePrompt: string,
 * }} args
 * @returns {{ systemPrompt: string, claudeMdLoaded: boolean, claudeMdSha?: string }}
 */
export function buildAgentSystemPrompt({ workingDir, contextPack, rolePrompt }) {
  const sections = [];
  const md = readClaudeMd(workingDir);
  let claudeMdSha;
  let claudeMdLoaded = false;
  if (md && !md.truncated) {
    sections.push(`# Project CLAUDE.md\n\n${md.content.trim()}`);
    claudeMdSha = md.sha;
    claudeMdLoaded = true;
  } else if (md && md.truncated) {
    sections.push(`# Project CLAUDE.md\n\n${md.content.trim()}`);
    claudeMdLoaded = false;
  }
  if (contextPack && contextPack.trim().length > 0) {
    sections.push(`# Project Context\n\n${contextPack.trim()}`);
  }
  sections.push(rolePrompt.trim());
  return {
    systemPrompt: sections.join('\n\n'),
    claudeMdLoaded,
    claudeMdSha,
  };
}

/**
 * Pure-string helper used by tests / debug log lines. Returns a one-line
 * provenance label for forensic emit:
 *
 *   "claude-md: loaded sha=<8-char> 4321B"
 *   "claude-md: missing"
 *   "claude-md: truncated 123KB"
 */
export function provenanceLabel(workingDir) {
  const md = readClaudeMd(workingDir);
  if (!md) return 'claude-md: missing';
  if (md.truncated) return `claude-md: truncated ${md.sizeBytes}B`;
  return `claude-md: loaded sha=${md.sha.slice(0, 8)} ${md.sizeBytes}B`;
}
