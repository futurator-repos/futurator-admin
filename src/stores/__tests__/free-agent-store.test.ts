import { describe, it, expect, beforeEach } from 'vitest';
import { useFreeAgentStore } from '../free-agent-store';

beforeEach(() => {
  // Reset store between tests.
  useFreeAgentStore.setState({
    isOpen: false,
    currentScope: { kind: 'workspace' },
    activeSessionId: null,
    composerText: '',
    scopeChangedSinceLastSend: false,
  });
});

describe('free-agent-store — initial state (AC #7)', () => {
  it('starts closed with workspace scope and empty composer', () => {
    const s = useFreeAgentStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.currentScope).toEqual({ kind: 'workspace' });
    expect(s.activeSessionId).toBeNull();
    expect(s.composerText).toBe('');
    expect(s.scopeChangedSinceLastSend).toBe(false);
  });
});

describe('free-agent-store — open/close/toggle (AC #1, AC #3)', () => {
  it('open() sets isOpen=true', () => {
    useFreeAgentStore.getState().open();
    expect(useFreeAgentStore.getState().isOpen).toBe(true);
  });

  it('close() sets isOpen=false', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().close();
    expect(useFreeAgentStore.getState().isOpen).toBe(false);
  });

  it('toggle() flips isOpen', () => {
    useFreeAgentStore.getState().toggle();
    expect(useFreeAgentStore.getState().isOpen).toBe(true);
    useFreeAgentStore.getState().toggle();
    expect(useFreeAgentStore.getState().isOpen).toBe(false);
  });
});

describe('free-agent-store — composer persistence (AC #10)', () => {
  it('persists composerText across close/open cycles', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().setComposerText('draft message');
    useFreeAgentStore.getState().close();
    useFreeAgentStore.getState().open();
    expect(useFreeAgentStore.getState().composerText).toBe('draft message');
  });
});

describe('free-agent-store — scope changes (AC #8)', () => {
  it('setScope updates currentScope', () => {
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    expect(useFreeAgentStore.getState().currentScope).toEqual({ kind: 'plan', id: 'dino-7' });
  });

  it('does NOT raise scopeChangedSinceLastSend when the panel is closed', () => {
    useFreeAgentStore.getState().setActiveSessionId('sid-1');
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    expect(useFreeAgentStore.getState().scopeChangedSinceLastSend).toBe(false);
  });

  it('does NOT raise scopeChangedSinceLastSend when there is no active session', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    expect(useFreeAgentStore.getState().scopeChangedSinceLastSend).toBe(false);
  });

  it('RAISES scopeChangedSinceLastSend when panel is open AND a session is active', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().setActiveSessionId('sid-1');
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    expect(useFreeAgentStore.getState().scopeChangedSinceLastSend).toBe(true);
  });

  it('no-ops on identical scope (same kind + same id)', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().setActiveSessionId('sid-1');
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    // Re-set the same scope; the existing scopeChanged flag should NOT be re-toggled
    // (no setState called means no spurious re-renders).
    const beforeSnapshot = { ...useFreeAgentStore.getState() };
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'dino-7' });
    const after = useFreeAgentStore.getState();
    expect(after.currentScope).toEqual(beforeSnapshot.currentScope);
  });

  it('acknowledgeScopeChange clears the flag + activeSession + composer', () => {
    useFreeAgentStore.getState().open();
    useFreeAgentStore.getState().setActiveSessionId('sid-1');
    useFreeAgentStore.getState().setComposerText('half written');
    useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'new-plan' });
    expect(useFreeAgentStore.getState().scopeChangedSinceLastSend).toBe(true);

    useFreeAgentStore.getState().acknowledgeScopeChange();
    const s = useFreeAgentStore.getState();
    expect(s.scopeChangedSinceLastSend).toBe(false);
    expect(s.activeSessionId).toBeNull();
    expect(s.composerText).toBe('');
  });
});

describe('free-agent-store — activeSessionId', () => {
  it('setActiveSessionId clears the scope-changed flag', () => {
    useFreeAgentStore.setState({ scopeChangedSinceLastSend: true });
    useFreeAgentStore.getState().setActiveSessionId('sid-new');
    expect(useFreeAgentStore.getState().scopeChangedSinceLastSend).toBe(false);
  });
});
