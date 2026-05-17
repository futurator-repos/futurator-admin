import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../lib/migrate-brownfield/logger.mjs';

function makeBuffer() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, read: () => chunks.join('') };
}

let out;
let err;
let log;

beforeEach(() => {
  out = makeBuffer();
  err = makeBuffer();
  log = createLogger({ stream: out.stream, errStream: err.stream, isTty: false });
});

describe('logger — basics (non-TTY)', () => {
  it('writes info() to stdout without color codes', () => {
    log.info('hello');
    expect(out.read()).toBe('hello\n');
    expect(out.read()).not.toMatch(/\x1b\[/);
  });

  it('writes ok() with leading checkmark', () => {
    log.ok('done');
    expect(out.read()).toBe('✔ done\n');
  });

  it('writes skip() with checkmark and suffix', () => {
    log.skip('secret');
    expect(out.read()).toContain('secret (already provisioned)');
  });

  it('writes fail() to stderr', () => {
    log.fail('broken');
    expect(err.read()).toContain('broken');
    expect(out.read()).toBe('');
  });

  it('writes step() as a numbered section', () => {
    log.step(3, 9, 'Ensure secret');
    expect(out.read()).toContain('[3/9] Ensure secret');
  });

  it('raw() preserves exact bytes without adding a newline', () => {
    log.raw('partial line');
    expect(out.read()).toBe('partial line');
  });
});

describe('logger — TTY color codes', () => {
  it('emits ANSI codes when isTty=true', () => {
    out = makeBuffer();
    err = makeBuffer();
    log = createLogger({ stream: out.stream, errStream: err.stream, isTty: true });
    log.ok('done');
    expect(out.read()).toMatch(/\x1b\[32m/);
  });
});

describe('logger — redactor', () => {
  it('runs redactor over every write', () => {
    out = makeBuffer();
    err = makeBuffer();
    log = createLogger({
      stream: out.stream,
      errStream: err.stream,
      isTty: false,
      redactor: (s) => s.replaceAll('SECRET', '***'),
    });
    log.info('this is SECRET data');
    log.fail('SECRET in error');
    expect(out.read()).toContain('***');
    expect(out.read()).not.toContain('SECRET');
    expect(err.read()).toContain('***');
    expect(err.read()).not.toContain('SECRET');
  });
});
