import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Labs3Header } from '../labs3-header';

// next/navigation router — the dialog navigates on success; we only need the
// shape so render doesn't throw.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('Labs3Header — Remove app affordance', () => {
  it('renders the Remove button only once an appId is resolved', () => {
    const { rerender } = wrap(<Labs3Header planId="p1" />);
    expect(screen.queryByText('Remove')).toBeNull();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <Labs3Header planId="p1" appId="snake-4" appLabel="Snake" />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('opens the destroy dialog with the full P3 teardown cascade + two-stage confirm', () => {
    wrap(<Labs3Header planId="p1" appId="snake-4" appLabel="Snake" />);
    fireEvent.click(screen.getByText('Remove'));

    // Names the app + the irreversible dev-env cascade (proves it is the P3 dialog).
    expect(screen.getByText(/Remove app/i)).toBeInTheDocument();
    expect(screen.getByText(/dev\.futurator\.ai\/snake-4/)).toBeInTheDocument();
    expect(screen.getByText(/QA before\/after screenshots/i)).toBeInTheDocument();

    // The destructive button is gated until BOTH confirmations match.
    const destroy = screen.getByRole('button', { name: /Remove forever/i });
    expect(destroy).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('snake-4'), { target: { value: 'snake-4' } });
    fireEvent.change(screen.getByPlaceholderText('DESTROY'), { target: { value: 'DESTROY' } });
    expect(destroy).toBeEnabled();
  });
});
