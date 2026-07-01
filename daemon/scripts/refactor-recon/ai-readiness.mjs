#!/usr/bin/env node
// ai-readiness.mjs — Refactoring Scan Engine v2, the AI-agent readiness detector.
//
// Deterministic, ~0 LLM, CONTENT/PATH-SIGNAL based (NOT convention-locked). Answers:
// is this codebase set up for AI-agent development? Detects Claude Code (CLAUDE.md,
// .claude/, settings), Skills, Subagents, Slash commands, Hooks, MCP, plus other
// agent tools (Cursor, Copilot, AGENTS.md, Windsurf, aider, CONVENTIONS.md).
//
// For a migration/refactor target, missing AI onboarding is a gentle, actionable
// signal — an agent that lacks CLAUDE.md/AGENTS.md has no project context to reason
// from, so it re-discovers conventions every run.
//
// USAGE: node ai-readiness.mjs <repo> [--out file]

import fs from 'node:fs';
import path from 'node:path';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Other agent-tool detectors — {key, name, match(base, rel)}. Folder-agnostic.
const OTHER = [
  { key: 'cursor', name: 'Cursor', match: (base, rel) => base === '.cursorrules' || /(^|\/)\.cursor\/rules(\/|$)/i.test(rel) },
  { key: 'copilot', name: 'GitHub Copilot', match: (base, rel) => /(^|\/)\.github\/copilot-instructions\.md$/i.test(rel) },
  { key: 'agents', name: 'AGENTS.md', match: (base) => base === 'AGENTS.md' },
  { key: 'windsurf', name: 'Windsurf', match: (base) => base === '.windsurfrules' },
  { key: 'aider', name: 'aider', match: (base) => base === '.aider.conf.yml' || base === '.aiderignore' },
  { key: 'conventions', name: 'CONVENTIONS.md', match: (base) => base === 'CONVENTIONS.md' },
];

const finding = (o) => ({
  id: o.id,
  dimension: 'code-quality-refactoring',
  area: 'ai-readiness',
  severity: o.severity || 'Low',
  effort: o.effort || 'Small',
  location: o.location || 'CLAUDE.md',
  issue: o.issue,
  suggestion: o.suggestion,
  evidence: { aiReadiness: true, check: o.check, ...(o.evidence || {}) },
  source: 'deterministic',
  dependsOn: [],
});

/**
 * Pure builder. @param files [{rel, content?}] — content only needed for
 * .claude/settings*.json (hooks/mcpServers) and .mcp.json.
 * @returns C-AI AiReadiness + findings
 */
export function buildAiReadiness(files = []) {
  const claudeFiles = []; // CLAUDE.md anywhere
  const claudeDirFiles = []; // any file under a .claude/ dir
  const skillFiles = [];
  const agentFiles = [];
  const commandFiles = [];
  const settingsFiles = [];
  const mcpFiles = [];
  let hasHooks = false;
  let hasMcp = false;
  const otherHits = {}; // key -> [rel]

  for (const f of files) {
    const rel = f && f.rel;
    if (!rel) continue;
    const content = typeof f.content === 'string' ? f.content : '';
    const base = rel.split('/').pop();

    if (base === 'CLAUDE.md') claudeFiles.push(rel);
    if (/(^|\/)\.claude\//.test(rel)) claudeDirFiles.push(rel);

    if (/(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/i.test(rel)) skillFiles.push(rel);
    else if (/(^|\/)\.claude\/agents\/[^/]+\.md$/i.test(rel)) agentFiles.push(rel);
    else if (/(^|\/)\.claude\/commands\/[^/]+\.md$/i.test(rel)) commandFiles.push(rel);

    if (/(^|\/)\.claude\/settings(\.local)?\.json$/i.test(rel)) {
      settingsFiles.push(rel);
      if (/"hooks"/.test(content)) hasHooks = true;
      if (/"mcpServers"/.test(content)) { hasMcp = true; mcpFiles.push(rel); }
    }
    if (base === '.mcp.json') { hasMcp = true; mcpFiles.push(rel); }

    for (const t of OTHER) {
      if (t.match(base, rel)) (otherHits[t.key] ||= []).push(rel);
    }
  }

  const skillCount = skillFiles.length;
  const agentCount = agentFiles.length;
  const commandCount = commandFiles.length;
  const hasClaudeCode = claudeFiles.length > 0 || claudeDirFiles.length > 0;

  // ── tools[] ──
  const tools = [];
  const claudeAllFiles = [...new Set([...claudeFiles, ...claudeDirFiles])].slice(0, 100);
  const claudeDetail = [];
  if (claudeFiles.length) claudeDetail.push('CLAUDE.md');
  if (settingsFiles.length) claudeDetail.push('settings');
  if (skillCount) claudeDetail.push(plural(skillCount, 'skill'));
  if (agentCount) claudeDetail.push(plural(agentCount, 'subagent'));
  if (commandCount) claudeDetail.push(plural(commandCount, 'command'));
  if (hasMcp) claudeDetail.push('MCP');
  if (hasHooks) claudeDetail.push('hooks');
  tools.push({
    name: 'Claude Code',
    present: hasClaudeCode,
    detail: hasClaudeCode ? claudeDetail.join(', ') : 'not detected',
    files: claudeAllFiles,
  });
  for (const t of OTHER) {
    const fl = otherHits[t.key] || [];
    tools.push({ name: t.name, present: fl.length > 0, detail: fl.length ? fl.join(', ') : 'not detected', files: fl });
  }

  // ── summary ──
  const parts = [];
  if (hasClaudeCode) parts.push('Claude Code');
  if (skillCount) parts.push(plural(skillCount, 'skill'));
  if (agentCount) parts.push(plural(agentCount, 'subagent'));
  if (commandCount) parts.push(plural(commandCount, 'command'));
  if (hasMcp) parts.push('MCP');
  if (hasHooks) parts.push('hooks');
  for (const t of OTHER) {
    if ((otherHits[t.key] || []).length) parts.push(t.name);
  }
  const summary = parts.length ? parts.join(' · ') : 'no AI-agent config detected';

  // ── findings (gentle) ──
  const findings = [];
  const agentsPresent = (otherHits.agents || []).length > 0;
  const cursorPresent = (otherHits.cursor || []).length > 0;
  if (!hasClaudeCode && !agentsPresent && !cursorPresent) {
    findings.push(finding({
      id: 'ai:no-onboarding', check: 'no-ai-onboarding', severity: 'Low', effort: 'Small',
      location: 'CLAUDE.md:1',
      issue: 'No AI-agent onboarding (CLAUDE.md / AGENTS.md) — agents lack project context',
      suggestion: 'Add a CLAUDE.md (or AGENTS.md) capturing architecture, conventions, and key commands so agents start with project context instead of re-discovering it each run',
    }));
  }

  return { tools, hasClaudeCode, skillCount, agentCount, commandCount, hasMcp, hasHooks, summary, findings };
}

// ── CLI ──
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage', 'graphify-out', 'vendor']);
const WANT_DOT_DIR = new Set(['.claude', '.cursor', '.github']);

function wanted(rel) {
  const base = rel.split('/').pop();
  if (base === 'CLAUDE.md' || base === 'AGENTS.md' || base === 'CONVENTIONS.md') return true;
  if (base === '.mcp.json' || base === '.cursorrules' || base === '.windsurfrules' || base === '.aider.conf.yml' || base === '.aiderignore') return true;
  if (/(^|\/)\.claude\//.test(rel)) return true;
  if (/(^|\/)\.cursor\/rules(\/|$)/i.test(rel)) return true;
  if (/(^|\/)\.github\/copilot-instructions\.md$/i.test(rel)) return true;
  return false;
}

function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith('.') && e.isDirectory() && !WANT_DOT_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'ai-readiness.json');
  const files = [];
  for (const full of walk(repo)) {
    const rel = path.relative(repo, full);
    if (!wanted(rel)) continue;
    let content = '';
    try { if (fs.statSync(full).size < 512 * 1024) content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    files.push({ rel, content });
  }
  const report = buildAiReadiness(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...report }, null, 2));
  console.error(`[ai-readiness] ${report.summary} (skills:${report.skillCount} agents:${report.agentCount} commands:${report.commandCount} mcp:${report.hasMcp} hooks:${report.hasHooks}) → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
