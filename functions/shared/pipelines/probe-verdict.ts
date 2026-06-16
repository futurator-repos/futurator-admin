import { isDeterministicLevel, type ResolvedLevel } from '../services/visual-test-classifier';

/**
 * VQA v3 (E6.2 / E6.3, H7) — the single probe verdict vocabulary + the
 * `(level × verdict) → block` rule, shared by BOTH checkpoints (wave gate and
 * QA Review). Today the two run disjoint vocabularies — the daemon emits
 * PASS|FAIL|UNREACHABLE|UNVERIFIABLE|UNCERTAIN, the QA pipeline pass|fail|uncertain.
 * This canonicalizes them so the block rule (FR-21) is computable in one place.
 *
 * E6 scope is grammar/types/verdict + the block rule ONLY — the daemon's
 * agentic-evidence rewrite is E13 (H7). See concept-qa-v2-epics.md E6/E13.
 */

export type ProbeVerdict = 'pass' | 'fail' | 'uncertain' | 'unreachable';

export type Checkpoint = 'wave-gate' | 'qa-review';

/** Map any legacy verdict token (upper/lower, either vocabulary) to canonical. */
export function normalizeVerdict(raw: unknown): ProbeVerdict {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'fail') return 'fail';
  // UNREACHABLE / UNVERIFIABLE both collapse to "couldn't reach the state".
  if (v === 'unreachable' || v === 'unverifiable') return 'unreachable';
  return 'uncertain';
}

/**
 * FR-21 — does this (level, verdict) at this checkpoint BLOCK green?
 *
 * Rules:
 *  - Only a `fail` can block. uncertain/unreachable/pass never block.
 *  - **Vision tiers (L1, L2-vision) NEVER block** — a probabilistic oracle must
 *    not gate a ship (it routes to ac-wording / operator instead).
 *  - **Deterministic failures (L0, L2-state) block** — but with the OQ3 caveat:
 *    at the WAVE GATE, L2-state is non-blocking until the agentic-evidence path
 *    is replaced by the programmatic runner (E13). L0 blocks at both checkpoints.
 *    At QA Review, every deterministic failure blocks.
 */
export function blocksGreen(args: {
  level: ResolvedLevel;
  verdict: ProbeVerdict;
  checkpoint: Checkpoint;
}): boolean {
  if (args.verdict !== 'fail') return false;
  if (!isDeterministicLevel(args.level)) return false; // vision never blocks
  // Deterministic failure. OQ3: wave-gate L2-state stays non-blocking until E13.
  if (args.checkpoint === 'wave-gate' && args.level === 'L2-state') return false;
  return true;
}
