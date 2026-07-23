// One runnable check: the builder is mode-correct, AC-aware, and the adapter
// emits a real Claude flag. Run: node --test spikes/ponytail/__tests__/inject-lazy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, getLazyInstructions, lazyArgs } from '../inject-lazy.mjs';

test('resolveMode falls back to full for unknown/off/empty', () => {
  assert.equal(resolveMode('ultra'), 'ultra');
  assert.equal(resolveMode('off'), 'full');
  assert.equal(resolveMode(''), 'full');
  assert.equal(resolveMode(undefined), 'full');
});

test('instructions carry the mode banner, the ladder, and the AC override', () => {
  const text = getLazyInstructions('lite');
  assert.match(text, /level: lite/);
  assert.match(text, /first rung that holds/i);          // the ladder
  assert.match(text, /bound acceptance criteria/i);       // AC-aware override
  assert.match(text, /ponytail:/);                        // debt-marker convention
});

test('lazyArgs emits a Claude --append-system-prompt pair', () => {
  const args = lazyArgs('full');
  assert.equal(args[0], '--append-system-prompt');
  assert.match(args[1], /LAZY DEV MODE ACTIVE/);
});
