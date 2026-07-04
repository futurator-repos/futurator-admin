/**
 * before-after-gallery.test.tsx — QA-Review W2, Lane 2 (VQA judge) gallery.
 *
 * Pins:
 * - collectVqaSteps flattens journeys → only steps carrying a `vqa` payload,
 *   preserving journeyTitle/stepLabel/sourceDiffRef.
 * - verdictBorderColor maps pass/fail/uncertain to the right CSS var.
 * - A step with beforeShotUrl + afterShotUrl renders TWO imgs (never a
 *   single frame).
 * - A broken (404) frame swaps to the "evidence broken" chip on img onError.
 * - A 'fail' vqa verdict renders the rationale text and a destructive-tinted
 *   card border.
 * - The empty-state renders when no journeys carry a vqa payload.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  BeforeAfterGallery,
  collectVqaSteps,
  verdictBorderColor,
  isDiffRefUrl,
} from '../before-after-gallery';
import type { JourneyResult } from '@/types/qa-review-p3';

function journeyWithVqa(overrides?: {
  verdict?: 'pass' | 'fail' | 'uncertain';
  rationale?: string;
  beforeShotUrl?: string;
  afterShotUrl?: string;
  sourceDiffRef?: string;
}): JourneyResult {
  return {
    id: 'journey-1',
    title: 'Sign up and post a message',
    acRefs: ['AC1'],
    verdict: overrides?.verdict ?? 'pass',
    steps: [
      {
        label: 'Submit the form',
        action: 'click #submit',
        deterministic: { assertion: 'form submits', passed: true, detail: 'ok' },
        vqa: {
          verdict: overrides?.verdict ?? 'pass',
          rationale: overrides?.rationale ?? 'The confirmation banner rendered as specified.',
          beforeShotUrl: overrides?.beforeShotUrl ?? 'https://shots/before.png',
          afterShotUrl: overrides?.afterShotUrl ?? 'https://shots/after.png',
          sourceDiffRef: overrides?.sourceDiffRef ?? 'src/components/form.tsx#L20-40',
        },
      },
    ],
  };
}

describe('collectVqaSteps', () => {
  it('flattens journeys to only the steps carrying a vqa payload', () => {
    const journeys: JourneyResult[] = [
      journeyWithVqa(),
      {
        id: 'journey-2',
        title: 'No VQA here',
        acRefs: [],
        verdict: 'pass',
        steps: [
          {
            label: 'A deterministic-only step',
            action: 'reach #x',
            deterministic: { assertion: 'exists', passed: true, detail: 'ok' },
          },
        ],
      },
    ];
    const entries = collectVqaSteps(journeys);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      journeyId: 'journey-1',
      journeyTitle: 'Sign up and post a message',
      stepLabel: 'Submit the form',
      sourceDiffRef: 'src/components/form.tsx#L20-40',
    });
  });

  it('returns an empty array when no journeys are given', () => {
    expect(collectVqaSteps([])).toEqual([]);
  });
});

describe('verdictBorderColor', () => {
  it('maps fail → destructive', () => {
    expect(verdictBorderColor('fail')).toBe('var(--destructive)');
  });
  it('maps uncertain → warning', () => {
    expect(verdictBorderColor('uncertain')).toBe('var(--warning)');
  });
  it('maps pass → success', () => {
    expect(verdictBorderColor('pass')).toBe('var(--success)');
  });
});

describe('isDiffRefUrl', () => {
  it('detects an http(s) ref as a URL', () => {
    expect(isDiffRefUrl('https://github.com/org/repo/pull/1')).toBe(true);
  });
  it('treats a bare path/key ref as not a URL', () => {
    expect(isDiffRefUrl('src/components/form.tsx#L20-40')).toBe(false);
  });
});

describe('BeforeAfterGallery', () => {
  it('renders the empty state when no step carries a vqa payload', () => {
    render(<BeforeAfterGallery journeys={[]} />);
    expect(screen.getByText(/no before\/after vqa evidence/i)).toBeInTheDocument();
  });

  it('renders the before/after PAIR — two imgs, never a single frame', () => {
    render(<BeforeAfterGallery journeys={[journeyWithVqa()]} />);
    const imgs = screen.getAllByRole('img');
    expect(imgs).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Before frame' })).toHaveAttribute(
      'src',
      'https://shots/before.png',
    );
    expect(screen.getByRole('img', { name: 'After frame' })).toHaveAttribute(
      'src',
      'https://shots/after.png',
    );
  });

  it('opens each frame in a new tab', () => {
    render(<BeforeAfterGallery journeys={[journeyWithVqa()]} />);
    const links = screen.getAllByTitle(/open (before|after) frame in a new tab/i);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('swaps a broken (404) frame to the "evidence broken" chip on img error', () => {
    render(<BeforeAfterGallery journeys={[journeyWithVqa()]} />);
    const beforeImg = screen.getByRole('img', { name: 'Before frame' });
    fireEvent.error(beforeImg);

    // The broken-evidence chip replaces the img — reads "evidence broken",
    // not "no screenshot".
    expect(screen.queryByRole('img', { name: 'Before frame' })).not.toBeInTheDocument();
    expect(screen.getByText('evidence broken')).toBeInTheDocument();
    // The other frame is unaffected.
    expect(screen.getByRole('img', { name: 'After frame' })).toBeInTheDocument();
  });

  it('a fail verdict renders the rationale and a destructive-tinted card', () => {
    const { container } = render(
      <BeforeAfterGallery
        journeys={[
          journeyWithVqa({
            verdict: 'fail',
            rationale: 'The panel rendered a flat colored square instead of the chart.',
          }),
        ]}
      />,
    );
    expect(
      screen.getByText('The panel rendered a flat colored square instead of the chart.'),
    ).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();

    const card = container.querySelector('section > div');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ border: '1px solid var(--destructive)' });
  });

  it('renders the source diff ref as a code snippet for a bare path', () => {
    render(<BeforeAfterGallery journeys={[journeyWithVqa()]} />);
    expect(screen.getByText('src/components/form.tsx#L20-40')).toBeInTheDocument();
  });

  it('renders the source diff ref as an openable link when it is a URL', () => {
    render(
      <BeforeAfterGallery
        journeys={[journeyWithVqa({ sourceDiffRef: 'https://github.com/org/repo/pull/1' })]}
      />,
    );
    const link = screen.getByRole('link', { name: /github\.com\/org\/repo\/pull\/1/ });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/1');
  });
});
