/**
 * agentic-journeys-section.test.tsx — Slice B, the "Run visual QA" trigger.
 *
 * Pins:
 * - The section renders (with the button) even when `report.agentic` is
 *   absent — empty-state "No visual QA runs yet.", not a `null` render.
 * - The Run-visual-QA button is disabled (with a reason) when the plan has
 *   no devUrl.
 * - Clicking it fires useRunAgenticQa with `{ mode: 'auto' }` against the
 *   plan-keyed agentic-run endpoint (mocked api-client).
 * - A 409 from the API renders an inline aria-live error line.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// ── Mock the api-client so the real hooks hit an in-test fake ──
const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

import { AgenticJourneysSection, isAgenticRunConflict } from '../agentic-journeys-section';
import type { AgenticReport } from '../agentic-journeys-section';

function makeAgentic(over: Partial<AgenticReport> = {}): AgenticReport {
  return {
    mode: 'headless',
    model: 'sonnet-5',
    runs: [],
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('isAgenticRunConflict', () => {
  it('is true for an error with status 409', () => {
    const err = Object.assign(new Error('conflict'), { status: 409 });
    expect(isAgenticRunConflict(err)).toBe(true);
  });

  it('is false for a non-409 error and non-error values', () => {
    const err = Object.assign(new Error('boom'), { status: 500 });
    expect(isAgenticRunConflict(err)).toBe(false);
    expect(isAgenticRunConflict(null)).toBe(false);
    expect(isAgenticRunConflict(undefined)).toBe(false);
  });
});

describe('AgenticJourneysSection', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state and the button even when agentic is absent', () => {
    render(<AgenticJourneysSection planId="plan-1" devUrl="https://dev.example/plan-1" />, {
      wrapper,
    });
    expect(screen.getByText(/no visual qa runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run visual qa/i })).toBeInTheDocument();
  });

  it('disables the button with a reason when the plan has no devUrl', () => {
    render(<AgenticJourneysSection planId="plan-1" agentic={makeAgentic()} />, { wrapper });
    const btn = screen.getByRole('button', { name: /run visual qa disabled/i });
    expect(btn).toBeDisabled();
    expect(btn.title).toMatch(/deploy a dev build first/i);
  });

  it('fires the mutation with mode auto when clicked', async () => {
    postMock.mockResolvedValue({ planId: 'plan-1', queued: true });
    render(
      <AgenticJourneysSection
        planId="plan-1"
        devUrl="https://dev.example/plan-1"
        agentic={makeAgentic()}
      />,
      { wrapper },
    );
    const btn = screen.getByRole('button', { name: 'Run visual QA' });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(postMock).toHaveBeenCalledWith('/plans/plan-1/qa/agentic-run', { mode: 'auto' });
    expect(await screen.findByText(/queued/i)).toBeInTheDocument();
  });

  it('renders an inline aria-live error line on a 409 conflict', async () => {
    postMock.mockRejectedValue(Object.assign(new Error('already running'), { status: 409 }));
    render(
      <AgenticJourneysSection
        planId="plan-1"
        devUrl="https://dev.example/plan-1"
        agentic={makeAgentic()}
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run visual QA' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveTextContent(/already in progress/i);
  });
});
