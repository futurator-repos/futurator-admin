/**
 * widget.test.tsx — Story 18.4 component tests.
 *
 * Component-level coverage of the widget shell. Backend mocked (no API calls).
 * Auth-store + EC2 mode controlled directly via store/localStorage setters.
 *
 * Story 18.5 will add streaming-wire tests; Story 18.6 will add thread-list tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

// Mock next/navigation since jsdom has no Next router.
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/labs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Story 18.5 — the panel uses TanStack Query via useFreeAgentSession.
// Tests need a QueryClientProvider wrapper. Mock fetch so the hook's
// network calls return empty data instead of hitting a real network.
vi.stubGlobal(
  'fetch',
  vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ),
);

function renderWithQuery(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

import { usePathname, useSearchParams } from 'next/navigation';
import { useFreeAgentStore } from '@/stores/free-agent-store';
import { useAuthStore } from '@/stores/auth-store';
import { FreeAgentWidget } from '../widget';
import { FreeAgentMessageThread } from '../message-thread';
import { FreeAgentComposer } from '../composer';

const EC2_KEY = 'futurator.labs.runtimeMode';

function resetStores() {
  useFreeAgentStore.setState({
    isOpen: false,
    currentScope: { kind: 'workspace' },
    activeSessionId: null,
    composerText: '',
    scopeChangedSinceLastSend: false,
  });
  useAuthStore.setState({
    user: null,
    tokens: null,
    isAuthenticated: false,
    isLoading: false,
  });
  localStorage.setItem(EC2_KEY, 'ec2');
  vi.mocked(usePathname).mockReturnValue('/labs');
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
}

beforeEach(() => {
  resetStores();
});

describe('FreeAgentWidget — auth gating (AC #1)', () => {
  it('renders nothing when the user is unauthenticated', () => {
    const { container } = renderWithQuery(<FreeAgentWidget />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the FAB when authenticated', () => {
    useAuthStore.setState({ isAuthenticated: true });
    renderWithQuery(<FreeAgentWidget />);
    expect(screen.getByTestId('free-agent-fab')).toBeInTheDocument();
  });
});

describe('FreeAgentWidget — open/close flow (AC #2, AC #3)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('clicking the FAB opens the panel', () => {
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect(screen.getByTestId('free-agent-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('free-agent-fab')).not.toBeInTheDocument();
  });

  it('clicking the close button closes the panel', () => {
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    fireEvent.click(screen.getByTestId('free-agent-close'));
    expect(screen.queryByTestId('free-agent-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('free-agent-fab')).toBeInTheDocument();
  });
});

describe('FreeAgentWidget — EC2 mode gating (AC #9)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('marks the FAB disabled when EC2 mode is local', () => {
    localStorage.setItem(EC2_KEY, 'local');
    renderWithQuery(<FreeAgentWidget />);
    const fab = screen.getByTestId('free-agent-fab');
    expect(fab).toHaveAttribute('data-disabled', 'true');
    expect(fab).toHaveAttribute('title', expect.stringContaining('Switch to EC2'));
  });

  it('marks the FAB enabled when EC2 mode is ec2', () => {
    localStorage.setItem(EC2_KEY, 'ec2');
    renderWithQuery(<FreeAgentWidget />);
    expect(screen.getByTestId('free-agent-fab')).toHaveAttribute('data-disabled', 'false');
  });

  it('clicking the disabled FAB does NOT open the panel', () => {
    localStorage.setItem(EC2_KEY, 'local');
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect(screen.queryByTestId('free-agent-panel')).not.toBeInTheDocument();
  });
});

describe('FreeAgentWidget — lens label (AC #4, AC #8)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('shows the Workspace lens by default', () => {
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect(screen.getByTestId('free-agent-lens-label')).toHaveTextContent('Assistant — Workspace');
  });

  it('shows a Plan: <id> lens when navigated to /labs?planId=...', () => {
    vi.mocked(usePathname).mockReturnValue('/labs');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('planId=plan-abc') as unknown as ReturnType<typeof useSearchParams>,
    );
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect(screen.getByTestId('free-agent-lens-label')).toHaveTextContent(
      'Assistant — Plan: plan-abc',
    );
  });

  it('shows a Project: <id> lens on /labs/projects/:id', () => {
    vi.mocked(usePathname).mockReturnValue('/labs/projects/dino-7');
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect(screen.getByTestId('free-agent-lens-label')).toHaveTextContent(
      'Assistant — Project: dino-7',
    );
  });

  it('shows scope-changed callout when scope changes mid-session', () => {
    useAuthStore.setState({ isAuthenticated: true });
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    // Simulate a session in progress by setting activeSessionId via the store.
    act(() => {
      useFreeAgentStore.getState().setActiveSessionId('sid-1');
    });
    // Now simulate a route change → store scope change.
    act(() => {
      useFreeAgentStore.getState().setScope({ kind: 'plan', id: 'new-plan' });
    });
    expect(screen.getByTestId('free-agent-scope-changed-callout')).toBeInTheDocument();
  });
});

describe('FreeAgentMessageThread — empty + bubble rendering (AC #5)', () => {
  it('shows the empty placeholder when no messages', () => {
    render(<FreeAgentMessageThread />);
    expect(screen.getByTestId('free-agent-thread-empty')).toHaveTextContent(
      'Send a message to start',
    );
  });

  it('renders user messages right-aligned with accent color', () => {
    render(<FreeAgentMessageThread messages={[{ id: '1', role: 'user', content: 'hi' }]} />);
    expect(screen.getByTestId('free-agent-user-bubble')).toHaveTextContent('hi');
    expect(screen.queryByTestId('free-agent-assistant-bubble')).not.toBeInTheDocument();
  });

  it('renders assistant messages left-aligned with muted color', () => {
    render(
      <FreeAgentMessageThread messages={[{ id: '1', role: 'assistant', content: 'hello!' }]} />,
    );
    expect(screen.getByTestId('free-agent-assistant-bubble')).toHaveTextContent('hello!');
  });
});

describe('FreeAgentComposer — keyboard handling (AC #6)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('Cmd+Enter sends the message', () => {
    const onSend = vi.fn();
    useFreeAgentStore.getState().setComposerText('hello world');
    render(<FreeAgentComposer onSend={onSend} />);

    const textarea = screen.getByTestId('free-agent-composer');
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    // (text, images?, previewUrls?) — both optional args are undefined when
    // the operator hasn't pasted any images.
    expect(onSend).toHaveBeenCalledWith('hello world', undefined, undefined);
    expect(useFreeAgentStore.getState().composerText).toBe('');
  });

  it('Ctrl+Enter also sends (Linux/Windows path)', () => {
    const onSend = vi.fn();
    useFreeAgentStore.getState().setComposerText('linux send');
    render(<FreeAgentComposer onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId('free-agent-composer'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(onSend).toHaveBeenCalledWith('linux send', undefined, undefined);
  });

  it('Shift+Enter inserts a newline (does NOT send)', () => {
    const onSend = vi.fn();
    useFreeAgentStore.getState().setComposerText('hello');
    render(<FreeAgentComposer onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId('free-agent-composer'), {
      key: 'Enter',
      shiftKey: true,
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('bare Enter does NOT send (prevents accidental sends)', () => {
    const onSend = vi.fn();
    useFreeAgentStore.getState().setComposerText('hello');
    render(<FreeAgentComposer onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId('free-agent-composer'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('send button is disabled when composer is empty', () => {
    render(<FreeAgentComposer onSend={vi.fn()} />);
    expect(screen.getByTestId('free-agent-send')).toBeDisabled();
  });

  it('send button is disabled while isSending=true', () => {
    useFreeAgentStore.getState().setComposerText('hi');
    render(<FreeAgentComposer isSending={true} onSend={vi.fn()} />);
    expect(screen.getByTestId('free-agent-send')).toBeDisabled();
  });
});

describe('FreeAgentComposer — composer text persistence (AC #10)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('preserves draft text across close/open', () => {
    renderWithQuery(<FreeAgentWidget />);
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    const textarea = screen.getByTestId('free-agent-composer') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'mid-thought draft' } });
    fireEvent.click(screen.getByTestId('free-agent-close'));
    fireEvent.click(screen.getByTestId('free-agent-fab'));
    expect((screen.getByTestId('free-agent-composer') as HTMLTextAreaElement).value).toBe(
      'mid-thought draft',
    );
  });
});
