import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INFRA_RETRIES,
  shouldConsumeAttempt,
  nextInfraRetry,
  annotate,
} from '../infra-retry.mjs';

describe('shouldConsumeAttempt', () => {
  it('does NOT consume an attempt for an infra classification', () => {
    assert.equal(shouldConsumeAttempt({ infra: true, reason: 'boot-000' }), false);
  });

  it('DOES consume an attempt for an app-fail classification', () => {
    assert.equal(shouldConsumeAttempt({ infra: false, reason: 'app-fail' }), true);
  });

  it('fails CLOSED (consumes) on a missing/malformed classification', () => {
    assert.equal(shouldConsumeAttempt(undefined), true);
    assert.equal(shouldConsumeAttempt({}), true);
    assert.equal(shouldConsumeAttempt(null), true);
  });
});

describe('nextInfraRetry — bounded 3, backoff 30s/60s/120s', () => {
  it('1st retry: 30s backoff', () => {
    const r = nextInfraRetry(0);
    assert.deepEqual(r, { retry: true, delayMs: 30_000, attempt: 1 });
  });

  it('2nd retry: 60s backoff', () => {
    const r = nextInfraRetry(1);
    assert.deepEqual(r, { retry: true, delayMs: 60_000, attempt: 2 });
  });

  it('3rd retry: 120s backoff', () => {
    const r = nextInfraRetry(2);
    assert.deepEqual(r, { retry: true, delayMs: 120_000, attempt: 3 });
  });

  it('caps at MAX_INFRA_RETRIES — 4th call refuses to retry', () => {
    assert.equal(MAX_INFRA_RETRIES, 3);
    const r = nextInfraRetry(3);
    assert.equal(r.retry, false);
    assert.equal(r.delayMs, 0);
  });

  it('never exceeds the cap on runaway counts', () => {
    const r = nextInfraRetry(99);
    assert.equal(r.retry, false);
  });

  it('defaults count to 0 when omitted', () => {
    const r = nextInfraRetry();
    assert.equal(r.retry, true);
    assert.equal(r.delayMs, 30_000);
  });
});

describe('annotate', () => {
  it('is pure — never mutates the input job', () => {
    const job = { id: 's1', attemptsUsed: 1 };
    const frozen = JSON.stringify(job);
    annotate(job, { classification: { infra: true, reason: 'boot-404' }, decision: nextInfraRetry(0) });
    assert.equal(JSON.stringify(job), frozen);
  });

  it('bumps infraRetries + records the reason on a retry decision', () => {
    const job = { id: 's1' };
    const decision = nextInfraRetry(0);
    const out = annotate(job, { classification: { infra: true, reason: 'boot-000' }, decision });
    assert.equal(out.infraRetries, 1);
    assert.equal(out.infraRetryReason, 'boot-000');
    assert.equal(out.infraRetryExhausted, false);
  });

  it('marks infraRetryExhausted once the cap is hit on an infra failure', () => {
    const job = { id: 's1', infraRetries: 3 };
    const decision = nextInfraRetry(3);
    const out = annotate(job, { classification: { infra: true, reason: 'port-squatter' }, decision });
    assert.equal(decision.retry, false);
    assert.equal(out.infraRetryExhausted, true);
    // exhausted retries don't get a phantom bump past what was already used
    assert.equal(out.infraRetries, 3);
  });

  it('leaves infraRetryExhausted false for an app-fail classification (never infra-exhausted)', () => {
    const job = { id: 's1' };
    const out = annotate(job, { classification: { infra: false, reason: 'app-fail' }, decision: { retry: false, delayMs: 0, attempt: 0 } });
    assert.equal(out.infraRetryExhausted, false);
  });

  it('carries forward the prior reason when called with no classification', () => {
    const job = { id: 's1', infraRetryReason: 'boot-404' };
    const out = annotate(job, {});
    assert.equal(out.infraRetryReason, 'boot-404');
  });
});
