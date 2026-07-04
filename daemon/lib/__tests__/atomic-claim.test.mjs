import { describe, it, expect } from 'vitest';
import { buildOrphanReleaseParams } from '../atomic-claim.mjs';

describe('buildOrphanReleaseParams (stale-reaper self-heal)', () => {
  it('releases only when still claimed by the DEAD job', () => {
    const p = buildOrphanReleaseParams({ table: 't', storyId: 's1', deadJobId: 'dead-1', now: 0 });
    expect(p.ConditionExpression).toBe('#state = :claimed AND jobId = :deadJobId');
    expect(p.ExpressionAttributeValues[':deadJobId']).toBe('dead-1');
    expect(p.UpdateExpression).toMatch(/REMOVE claimOwner, claimToken, claimExpiresAt, jobId/);
    expect(p.ExpressionAttributeValues[':ready']).toBe('ready');
  });
});
