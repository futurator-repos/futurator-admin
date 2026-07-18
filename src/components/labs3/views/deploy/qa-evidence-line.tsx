'use client';

/**
 * QaEvidenceLine — the tri-state "commit <sha> QA-verified" evidence strip
 * (design doc I8 slice N3). Shared between DeploymentView (dev/staging) and
 * PublishView (production) so both promote surfaces show the same honest
 * evidence for the frozen commit being promoted — never a silent green.
 */

import { shortSha } from '../qa/dev-url-card';
import type { QaReadiness } from '@/hooks/use-p3-qa-report';

export function QaEvidenceLine({
  qaCommitSha,
  readiness,
}: {
  qaCommitSha: string | undefined;
  readiness: QaReadiness;
}) {
  const sha = shortSha(qaCommitSha ?? '');
  const meta =
    readiness === 'verified'
      ? { text: `commit ${sha} QA-verified`, color: 'var(--success)' }
      : readiness === 'blocking'
        ? { text: `commit ${sha} — QA blocking`, color: 'var(--destructive)' }
        : {
            text: qaCommitSha ? `commit ${sha} — QA not verified` : 'no QA verdict yet',
            color: 'var(--text-mute)',
          };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 4px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.04em',
        color: meta.color,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color }}
      />
      {meta.text}
    </div>
  );
}
