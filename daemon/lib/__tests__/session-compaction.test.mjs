import { describe, it, expect } from 'vitest';
import {
  decideCompaction,
  planCompaction,
  flattenImageTokens,
  RECENT_TURNS_TO_KEEP,
  CONTEXT_WINDOW_TOKENS,
} from '../compactor.mjs';
import { splitSystemPrompt, splitAtMarker } from '../system-prompt-split.mjs';
import { resumeArgs, threadDecision, resolveStageResumeArgs } from '../session-thread.mjs';

describe('decideCompaction (dual threshold)', () => {
  it('below soft → none', () => {
    expect(decideCompaction({ tokenCount: 0.5 * CONTEXT_WINDOW_TOKENS }).action).toBe('none');
  });
  it('soft@160k → soft', () => {
    expect(decideCompaction({ tokenCount: 160_000 }).action).toBe('soft'); // 0.80
  });
  it('hard@190k → hard', () => {
    expect(decideCompaction({ tokenCount: 190_000 }).action).toBe('hard'); // 0.95
  });
  it('exposes fraction + keepTurns', () => {
    const d = decideCompaction({ tokenCount: 100_000 });
    expect(d.fraction).toBe(0.5);
    expect(d.keepTurns).toBe(RECENT_TURNS_TO_KEEP);
  });
});

describe('planCompaction', () => {
  it('keeps the last RECENT turns verbatim, summarizes the rest', () => {
    const turns = Array.from({ length: 25 }, (_, i) => i);
    const { summarize, keep } = planCompaction(turns, 10);
    expect(keep).toHaveLength(10);
    expect(keep[0]).toBe(15);
    expect(summarize).toHaveLength(15);
  });
  it('no-op when turns ≤ keep (load-bearing floor)', () => {
    const { summarize, keep } = planCompaction([1, 2, 3], 10);
    expect(summarize).toEqual([]);
    expect(keep).toEqual([1, 2, 3]);
  });
});

describe('flattenImageTokens', () => {
  it('flat 1600 per image', () => {
    expect(flattenImageTokens(3)).toBe(4800);
    expect(flattenImageTokens(0)).toBe(0);
  });
});

describe('splitSystemPrompt', () => {
  it('static → append args, dynamic → prompt', () => {
    const { args, promptArg } = splitSystemPrompt({ staticPrompt: 'RULES', dynamicPrompt: 'do X' });
    expect(args).toEqual(['--append-system-prompt', 'RULES']);
    expect(promptArg).toBe('do X');
  });
  it('empty static → no append args', () => {
    expect(splitSystemPrompt({ dynamicPrompt: 'x' }).args).toEqual([]);
  });
  it('splitAtMarker splits cacheable prefix from story delta; absent marker → all dynamic', () => {
    const r = splitAtMarker('STATIC PART<<<STORY>>>dynamic part');
    expect(r.args[1]).toBe('STATIC PART');
    expect(r.promptArg).toBe('dynamic part');
    expect(splitAtMarker('no marker here').args).toEqual([]);
  });
});

describe('session-thread reuse decision', () => {
  it('off → fresh', () => {
    expect(threadDecision({ fromStage: 'dev', toStage: 'compile', reuseMode: 'off' }).kind).toBe('fresh');
  });
  it('dev→compile shares the session', () => {
    const d = threadDecision({ fromStage: 'dev', toStage: 'compile', reuseMode: 'dev_compile' });
    expect(d.share).toBe(true);
    expect(d.kind).toBe('share-session');
  });
  it('dev→review is ALWAYS facts-only, never shares dev transcript (even under full)', () => {
    expect(threadDecision({ fromStage: 'dev', toStage: 'review', reuseMode: 'dev_compile' }).kind).toBe('facts-only');
    const full = threadDecision({ fromStage: 'dev', toStage: 'review', reuseMode: 'full' });
    expect(full.share).toBe(false);
    expect(full.kind).toBe('facts-only');
  });
  it('resumeArgs builds --resume or []', () => {
    expect(resumeArgs('sess-1')).toEqual(['--resume', 'sess-1']);
    expect(resumeArgs(null)).toEqual([]);
  });
  it('resolveStageResumeArgs: share resumes prior; facts-only resumes facts session', () => {
    expect(resolveStageResumeArgs({ fromStage: 'dev', toStage: 'compile', reuseMode: 'dev_compile', priorSessionId: 'p' }).args).toEqual(['--resume', 'p']);
    expect(resolveStageResumeArgs({ fromStage: 'dev', toStage: 'review', reuseMode: 'full', priorSessionId: 'p', factsSessionId: 'f' }).args).toEqual(['--resume', 'f']);
  });
});
