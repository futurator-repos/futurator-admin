/**
 * qa-primitives.test.tsx — QA-Review W2 shared primitives.
 *
 * Pins:
 * - StatusChip renders the correct label for each LaneVerdict variant
 *   (pass | fail | uncertain).
 * - EvidenceImage renders the img when a src is given, and swaps to the
 *   "evidence broken" chip once the img fires onError (404 / broken upload).
 * - EvidenceImage renders the dash placeholder when no src is given.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusChip, EvidenceImage } from '../qa-primitives';

describe('StatusChip', () => {
  it('renders the pass variant', () => {
    render(<StatusChip status="pass" />);
    expect(screen.getByText('pass')).toBeInTheDocument();
  });

  it('renders the fail variant', () => {
    render(<StatusChip status="fail" />);
    expect(screen.getByText('fail')).toBeInTheDocument();
  });

  it('renders the uncertain variant', () => {
    render(<StatusChip status="uncertain" />);
    expect(screen.getByText('uncertain')).toBeInTheDocument();
  });
});

describe('EvidenceImage', () => {
  it('renders the dash placeholder when no src is given', () => {
    render(<EvidenceImage alt="no evidence" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an img when a src is given', () => {
    render(<EvidenceImage src="https://shots/before.png" alt="before shot" />);
    expect(screen.getByRole('img', { name: 'before shot' })).toBeInTheDocument();
  });

  it('swaps a broken (404) img to an "evidence broken" chip on error', () => {
    render(<EvidenceImage src="https://shots/broken.png" alt="broken shot" />);
    const img = screen.getByRole('img', { name: 'broken shot' });
    fireEvent.error(img);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('evidence broken')).toBeInTheDocument();
  });
});
