/**
 * dev-url-card.test.tsx — QA-Review W2 dev-preview card.
 *
 * Pins:
 * - The "Open dev ↗" link's href is EXACTLY devUrl, in every build status.
 * - The short SHA (7 chars) renders with its "frozen commit" caption.
 * - A `deploying` build status shows the spinner affordance.
 * - The three statuses (deploying / live / failed) each render distinctly.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DevUrlCard, shortSha, devPreviewStatusMeta } from '../dev-url-card';

const DEV_URL = 'https://dev.futurator.ai/plan-abc123';
const SHA = 'a1b2c3d4e5f6789';

describe('shortSha', () => {
  it('slices to 7 chars', () => {
    expect(shortSha(SHA)).toBe('a1b2c3d');
  });

  it('handles empty string', () => {
    expect(shortSha('')).toBe('—');
  });
});

describe('devPreviewStatusMeta', () => {
  it('maps live → success', () => {
    expect(devPreviewStatusMeta('live').color).toBe('var(--success)');
    expect(devPreviewStatusMeta('live').label).toBe('Live');
  });

  it('maps failed → destructive', () => {
    expect(devPreviewStatusMeta('failed').color).toBe('var(--destructive)');
  });

  it('maps deploying → warning', () => {
    expect(devPreviewStatusMeta('deploying').color).toBe('var(--warning)');
  });
});

describe('DevUrlCard', () => {
  it('renders the "Open dev ↗" link with href === devUrl', () => {
    render(<DevUrlCard devUrl={DEV_URL} qaCommitSha={SHA} status="live" />);
    const link = screen.getByRole('link', { name: /Open dev/ });
    expect(link).toHaveAttribute('href', DEV_URL);
  });

  it('renders the short SHA with the frozen-commit caption', () => {
    render(<DevUrlCard devUrl={DEV_URL} qaCommitSha={SHA} status="live" />);
    expect(screen.getByText('a1b2c3d')).toBeInTheDocument();
    expect(screen.getByText('QA ran against this frozen commit')).toBeInTheDocument();
  });

  it('shows the harness-ON badge', () => {
    render(<DevUrlCard devUrl={DEV_URL} qaCommitSha={SHA} status="live" />);
    expect(screen.getByText(/harness/i)).toBeInTheDocument();
  });

  it('deploying status shows the spinner', () => {
    render(<DevUrlCard devUrl={DEV_URL} qaCommitSha={SHA} status="deploying" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.getByText('Deploying')).toBeInTheDocument();
  });

  it.each([
    ['deploying', 'Deploying'],
    ['live', 'Live'],
    ['failed', 'Build failed'],
  ] as const)('renders the %s status label', (status, label) => {
    render(<DevUrlCard devUrl={DEV_URL} qaCommitSha={SHA} status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    // href stays pinned to devUrl regardless of build status.
    expect(screen.getByRole('link', { name: /Open dev/ })).toHaveAttribute('href', DEV_URL);
  });
});
