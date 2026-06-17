/**
 * skill-trust.test.mjs — Skills Institution, Story 4.2.
 *
 * The criterion-#2 invariant: no unvetted skill is installable, without breaking
 * the legacy working set (grandfathered on auto-trust sources only).
 */

import { describe, it, expect } from 'vitest';
import { isInstallable, installBlockReason } from '../skill-trust.mjs';

const auto = { autoTrust: true };
const community = { autoTrust: false };

describe('isInstallable', () => {
  it('trusted installs from any source', () => {
    expect(isInstallable({ trustTier: 'trusted' }, community)).toBe(true);
    expect(isInstallable({ trustTier: 'trusted' }, auto)).toBe(true);
  });

  it('explicitly-tiered-but-not-trusted never installs (even on auto-trust)', () => {
    for (const trustTier of ['reviewed', 'draft', 'deprecated']) {
      expect(isInstallable({ trustTier }, auto)).toBe(false);
      expect(isInstallable({ trustTier }, community)).toBe(false);
    }
  });

  it('legacy (no trustTier) is grandfathered ONLY on an auto-trust source', () => {
    expect(isInstallable({}, auto)).toBe(true);
    expect(isInstallable({}, community)).toBe(false);
    expect(isInstallable(undefined, auto)).toBe(true);
    expect(isInstallable(undefined, community)).toBe(false);
  });
});

describe('installBlockReason', () => {
  it('is null for installable entries', () => {
    expect(installBlockReason({ trustTier: 'trusted' }, community)).toBeNull();
    expect(installBlockReason({}, auto)).toBeNull();
  });
  it('names the gate that blocked', () => {
    expect(installBlockReason({ trustTier: 'reviewed' }, auto)).toBe('reviewed-not-trusted');
    expect(installBlockReason({ trustTier: 'draft' }, auto)).toBe('draft-not-ratified');
    expect(installBlockReason({ trustTier: 'deprecated' }, auto)).toBe('deprecated');
    expect(installBlockReason({}, community)).toBe('untrusted-source');
  });
});
