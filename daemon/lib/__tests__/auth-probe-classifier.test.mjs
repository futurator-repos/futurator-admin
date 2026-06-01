/**
 * auth-probe-classifier.test.mjs — 2026-05-21.
 *
 * Regression test for the daemon's auth-probe false-FAIL bug. The probe
 * was flipping authState.valid=false (→ "auth expired" badge in the UI)
 * whenever `claude -p` exited non-zero, even when the JSON body cleanly
 * said `is_error: false`. This caused the "auth expired but agent runs
 * anyway" symptom: the probe is wrong, the OAuth is fine, jobs spawn
 * and succeed.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyAuthProbeResult,
  isAuthFailureOutput,
} from '../auth-probe-classifier.mjs';

describe('classifyAuthProbeResult', () => {
  // The bug we're fixing: clean JSON + benign non-zero exit must be OK.
  it('trusts is_error:false even when exit code is non-zero (snake-4 fix)', () => {
    const result = classifyAuthProbeResult({
      exitCode: 1,
      parsed: {
        is_error: false,
        result: "I'm ready to help! What would you like to work on?",
      },
      combinedOutput: '{"is_error":false,"result":"I\'m ready to help!"}',
    });
    expect(result).toBe(true);
  });

  it('happy path: exit 0 + is_error:false → OK', () => {
    const result = classifyAuthProbeResult({
      exitCode: 0,
      parsed: { is_error: false, result: 'ok' },
      combinedOutput: '{"is_error":false,"result":"ok"}',
    });
    expect(result).toBe(true);
  });

  it('parsed is_error:true → FAIL (even with exit 0)', () => {
    const result = classifyAuthProbeResult({
      exitCode: 0,
      parsed: { is_error: true, result: 'rate limit' },
      combinedOutput: '{"is_error":true,"result":"rate limit"}',
    });
    expect(result).toBe(false);
  });

  it('auth-failure phrase wins regardless of parsed/exit', () => {
    // Phrase in output overrides everything, because Claude Code surfaces
    // OAuth rejection via stderr text rather than the JSON body.
    const result = classifyAuthProbeResult({
      exitCode: 0,
      parsed: { is_error: false, result: 'fine' },
      combinedOutput: 'Please run /login first',
    });
    expect(result).toBe(false);
  });

  it('no parsed JSON + exit 0 + no auth phrase → OK (fallback path)', () => {
    const result = classifyAuthProbeResult({
      exitCode: 0,
      parsed: null,
      combinedOutput: 'hello',
    });
    expect(result).toBe(true);
  });

  it('no parsed JSON + exit non-zero → FAIL (strict fallback)', () => {
    // When we don't have JSON we can't tell benign from real; stay strict.
    const result = classifyAuthProbeResult({
      exitCode: 1,
      parsed: null,
      combinedOutput: 'unparseable garbage',
    });
    expect(result).toBe(false);
  });

  it('no parsed JSON + auth phrase → FAIL (even with exit 0)', () => {
    const result = classifyAuthProbeResult({
      exitCode: 0,
      parsed: null,
      combinedOutput: '401 Unauthorized',
    });
    expect(result).toBe(false);
  });

  it('parsed but exit non-zero AND auth phrase → FAIL (phrase wins)', () => {
    const result = classifyAuthProbeResult({
      exitCode: 1,
      parsed: { is_error: false, result: 'ok' },
      combinedOutput: 'authentication_error: token expired',
    });
    expect(result).toBe(false);
  });
});

describe('isAuthFailureOutput', () => {
  it('matches 401', () => {
    expect(isAuthFailureOutput('Server returned 401 Unauthorized')).toBe(true);
  });

  it('matches authentication_error', () => {
    expect(isAuthFailureOutput('{"type":"authentication_error"}')).toBe(true);
  });

  it('matches unauthenticated', () => {
    expect(isAuthFailureOutput('Request unauthenticated')).toBe(true);
  });

  it('matches "Please run /login"', () => {
    expect(isAuthFailureOutput('Please run /login to authenticate')).toBe(true);
  });

  it('does NOT match the friendly "ready to help" response', () => {
    // This was the exact false-positive trigger: the daemon flagged this
    // as auth failure because of the strict exit-code check, then the UI
    // surfaced it as "auth expired."
    expect(
      isAuthFailureOutput("I'm ready to help! What would you like to work on?"),
    ).toBe(false);
  });

  it('does NOT match generic rate-limit text', () => {
    expect(isAuthFailureOutput('Rate limited, retry after 60s')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isAuthFailureOutput('')).toBe(false);
    expect(isAuthFailureOutput(null)).toBe(false);
    expect(isAuthFailureOutput(undefined)).toBe(false);
  });
});
