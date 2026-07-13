/**
 * launcher-grow-mode.test.tsx — the Labs3 quick-create card's brownfield
 * "Grow existing app" mode (P3 phased-planner redesign, slice G).
 *
 * Pins:
 * - Default mode is "New app": no app selector, greenfield submit (no targetAppId).
 * - "Grow existing app" reveals an app selector populated from useApps().
 * - Submit is disabled in grow mode until an app is chosen.
 * - Choosing an app + submitting posts targetAppId through to useQuickP3Plan.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mutate = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/use-plans', () => ({
  usePlansList: () => ({ data: [], isLoading: false, error: null }),
  useQuickP3Plan: () => ({ mutate, isPending: false }),
}));

vi.mock('@/hooks/use-daemon-status', () => ({
  useDaemonStatus: () => ({ data: undefined }),
}));

vi.mock('@/hooks/use-apps', () => ({
  useApps: () => ({
    data: [
      { appId: 'snake-4', displayName: 'Snake' },
      { appId: 'kanban', displayName: 'Kanban Board' },
    ],
  }),
}));

import { Labs3Launcher } from '../launcher';

describe('Labs3Launcher — Grow existing app mode', () => {
  beforeEach(() => mutate.mockReset());

  it('defaults to New app mode with no app selector', () => {
    render(<Labs3Launcher />);
    expect(screen.getByRole('button', { name: 'New app' })).toBeInTheDocument();
    expect(screen.queryByLabelText('App to grow')).toBeNull();
  });

  it('reveals an app selector populated from useApps in grow mode', () => {
    render(<Labs3Launcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Grow existing app' }));
    const select = screen.getByLabelText('App to grow');
    expect(select).toBeInTheDocument();
    // Both apps offered (sorted by display name); shows name + slug.
    expect(screen.getByRole('option', { name: /Kanban Board \(kanban\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Snake \(snake-4\)/ })).toBeInTheDocument();
  });

  it('disables submit in grow mode until an app is chosen', () => {
    render(<Labs3Launcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Grow existing app' }));
    fireEvent.change(screen.getByPlaceholderText(/Describe an app idea/), {
      target: { value: 'add a settings screen' },
    });
    const submit = screen.getByRole('button', { name: /Grow & Run Pipeline-3/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('App to grow'), { target: { value: 'snake-4' } });
    expect(submit).toBeEnabled();
  });

  it('submits targetAppId when growing an existing app', () => {
    render(<Labs3Launcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Grow existing app' }));
    fireEvent.change(screen.getByPlaceholderText(/Describe an app idea/), {
      target: { value: 'add a settings screen' },
    });
    fireEvent.change(screen.getByLabelText('App to grow'), { target: { value: 'snake-4' } });
    fireEvent.click(screen.getByRole('button', { name: /Grow & Run Pipeline-3/ }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      intent: 'add a settings screen',
      targetAppId: 'snake-4',
    });
  });

  it('does NOT send targetAppId in New app mode', () => {
    render(<Labs3Launcher />);
    fireEvent.change(screen.getByPlaceholderText(/Describe an app idea/), {
      target: { value: 'a tip calculator' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create & Run Pipeline-3/ }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].targetAppId).toBeUndefined();
  });
});
