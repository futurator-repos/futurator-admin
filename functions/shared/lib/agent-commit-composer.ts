/**
 * agent-commit-composer.ts — Story 20.13 (party-push Epic 20).
 *
 * TypeScript port of `daemon/pipelines/lib/agent-commit-composer.mjs`
 * (Story 19.5). Lambda + Daemon are separate packages with separate build
 * pipelines (Lambda via SST esbuild; Daemon via rsync of raw .mjs files),
 * so the composer ships in both languages. Both files MUST emit
 * byte-identical messages for the same input — covered by parity tests in
 * `__tests__/agent-commit-composer.test.ts` + the daemon's existing
 * `agent-commit-composer.test.mjs`.
 *
 * Output shapes are identical to the .mjs version. See that file's header
 * for full spec.
 */

const NOISE_TITLE_PATTERNS = [
  /^update$/i,
  /^updates$/i,
  /^change$/i,
  /^changes$/i,
  /^fix$/i,
  /^fixes$/i,
  /^wip$/i,
  /^untitled$/i,
];

/**
 * Strip C0 control chars (0x00–0x1f) except newline (0x0a) and tab (0x09),
 * DEL (0x7f), and zero-width Unicode (U+200B–U+200F, U+FEFF) + trailing
 * whitespace. §12.1.3 fix.
 */
export function sanitize(s: string | null | undefined): string {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[​-‏﻿]/g, '')
    .replace(/\s+$/g, '');
}

export interface ValidateTitleResult {
  clean: string;
  warnings: string[];
}

export function validateTitle(title: string): ValidateTitleResult {
  const clean = sanitize(title).trim();
  const warnings: string[] = [];
  if (clean.length === 0) {
    warnings.push('title-empty');
    return { clean, warnings };
  }
  if (NOISE_TITLE_PATTERNS.some((re) => re.test(clean))) {
    warnings.push('title-noise');
  }
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) warnings.push('title-too-short');
  return { clean, warnings };
}

export interface ValidateSummaryResult {
  clean: string;
  lines: string[];
}

export function validateSummary(summary: string | undefined): ValidateSummaryResult {
  const clean = sanitize(summary);
  if (clean.length === 0) return { clean: '', lines: [] };
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/g, ''));
  return { clean: lines.join('\n'), lines };
}

function slugifyParticipant(name: string): string {
  return sanitize(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function buildCoAuthors(participants: string[]): { lines: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  lines.push('Co-authored-by: BMad Master (Party) <party+bmad-master@futurator.ai>');
  seen.add('bmad-master');

  for (const raw of participants || []) {
    const cleanName = sanitize(raw).trim();
    if (!cleanName) continue;
    const slug = slugifyParticipant(cleanName) || 'participant';
    if (seen.has(slug)) {
      warnings.push(`coauthor-collision:${slug}`);
      continue;
    }
    seen.add(slug);
    lines.push(`Co-authored-by: ${cleanName} (Party) <party+${slug}@futurator.ai>`);
  }
  return { lines, warnings };
}

export interface PipelineV2Input {
  kind: 'pipeline';
  title: string;
  summary?: string;
  storyId: string;
  planId?: string;
  plan?: string;
  epicId?: string;
  wave?: string | number;
  agent?: string;
  skillsUsed?: string;
  skillsManifestSha?: string;
}

export interface PartyInput {
  kind: 'party';
  title: string;
  summary?: string;
  sessionId: string;
  projectId: string;
  round: number;
  trigger: string;
  debate?: string;
  participants?: string[];
}

export interface ComposeResult {
  message: string;
  coAuthors: string[];
  warnings: string[];
}

export function composeAgentCommit(input: PipelineV2Input | PartyInput): ComposeResult {
  if (!input || typeof input !== 'object') {
    throw new Error('composeAgentCommit: input is required');
  }
  if (input.kind !== 'pipeline' && input.kind !== 'party') {
    throw new Error(`composeAgentCommit: unknown kind '${(input as { kind?: string }).kind}'`);
  }

  const titleResult = validateTitle(input.title);
  const summaryResult = validateSummary(input.summary);
  const warnings = [...titleResult.warnings];

  if (input.kind === 'pipeline') {
    const subject = `story: ${sanitize(input.storyId)} — ${titleResult.clean || '(untitled)'}`;
    const body = summaryResult.clean;
    const trailers: string[] = [`Agent: ${sanitize(input.agent || 'DEV')}`];
    if (input.planId) trailers.push(`Plan-Id: ${sanitize(input.planId)}`);
    if (input.plan) trailers.push(`Plan: ${sanitize(input.plan)}`);
    if (input.epicId) trailers.push(`Epic-Id: ${sanitize(input.epicId)}`);
    if (input.wave !== undefined && input.wave !== null && input.wave !== '') {
      trailers.push(`Wave: ${sanitize(String(input.wave))}`);
    }
    trailers.push(`Story: ${sanitize(input.storyId)}`);
    if (input.skillsUsed) trailers.push(`Skills-Used: ${sanitize(input.skillsUsed)}`);
    if (input.skillsManifestSha) {
      trailers.push(`Skills-Manifest-Sha: ${sanitize(input.skillsManifestSha)}`);
    }
    const footer = '🤖 Generated with Claude Code via the Futurator pipeline';
    const message = [subject, '', body, '', trailers.join('\n'), '', footer]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { message, coAuthors: [], warnings };
  }

  const subject = `party(${sanitize(input.projectId)}/round-${input.round}): ${
    titleResult.clean || '(untitled)'
  }`;
  const body = summaryResult.clean;
  const trailers: string[] = [
    'Agent: PARTY-ORCHESTRATOR',
    `Session-Id: ${sanitize(input.sessionId)}`,
    `Project: ${sanitize(input.projectId)}`,
    `Round: ${input.round}`,
    `Trigger: ${sanitize(input.trigger)}`,
  ];
  if (input.debate) trailers.push(`Debate: ${sanitize(input.debate)}`);
  const participants = (input.participants || []).map((p) => sanitize(p).trim()).filter(Boolean);
  if (participants.length > 0) {
    trailers.push(`Participants: ${participants.join(', ')}`);
  }
  const { lines: coAuthorLines, warnings: coAuthorWarnings } = buildCoAuthors(participants);
  warnings.push(...coAuthorWarnings);

  const footer = '🤖 Generated by Futurator Party Mode';
  const segments = [
    subject,
    '',
    body,
    '',
    trailers.join('\n'),
    '',
    coAuthorLines.join('\n'),
    '',
    footer,
  ];
  const message = segments
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { message, coAuthors: coAuthorLines, warnings };
}

/**
 * Story 20.13 — extract just the v2.5 §23 structured trailer lines (without
 * subject / body / footer / co-authors) for callers that need to emit them
 * separately (e.g. `commit-metadata.ts`'s shell snippet computes Skills-*
 * trailers at exec time and needs to interleave them with the composer's
 * structured trailers).
 *
 * The block returned is what would land between the body and the footer
 * inside `composeAgentCommit`'s `pipeline` branch, EXCLUDING `Skills-Used`
 * and `Skills-Manifest-Sha` (those are exec-time shell substitutions).
 */
/**
 * Trailer-value normalizer: same as `sanitize`, plus newlines collapsed
 * to spaces. Trailers are single-line by v2.5 §23 spec — a multi-line
 * value would break `git log --grep=^Plan-Id:` and confuse rotation
 * extractors. Defensive against an upstream caller passing a multi-line
 * display name into `Plan:` etc.
 */
function trailerValue(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return '';
  return sanitize(String(v))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function buildPipelineStructuredTrailers(args: {
  storyId: string;
  agent?: string;
  planId?: string;
  plan?: string;
  epicId?: string;
  wave?: string | number;
}): string {
  const lines: string[] = [`Agent: ${trailerValue(args.agent || 'DEV')}`];
  if (args.planId) lines.push(`Plan-Id: ${trailerValue(args.planId)}`);
  if (args.plan) lines.push(`Plan: ${trailerValue(args.plan)}`);
  if (args.epicId) lines.push(`Epic-Id: ${trailerValue(args.epicId)}`);
  if (args.wave !== undefined && args.wave !== null && args.wave !== '') {
    lines.push(`Wave: ${trailerValue(args.wave)}`);
  }
  lines.push(`Story: ${trailerValue(args.storyId)}`);
  return lines.join('\n');
}
