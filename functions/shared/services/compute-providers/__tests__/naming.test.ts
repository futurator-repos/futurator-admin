import { describe, it, expect } from 'vitest';
import { toProviderResourceName } from '../naming';

// GCE's own rule, from the API error that produced this module.
const RFC1035 = /^(?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)$/;

describe('toProviderResourceName', () => {
  it('slugs the label that GCP actually rejected in production', () => {
    const name = toProviderResourceName('Google GCP Free trial 1', 'srv_gcp_ab12cd');
    expect(name).toBe('google-gcp-free-trial-1-ab12cd');
    expect(name).toMatch(RFC1035);
  });

  it('appends the serverId suffix so identically-labelled servers cannot collide', () => {
    const a = toProviderResourceName('my box', 'srv_gcp_aaaaaa');
    const b = toProviderResourceName('my box', 'srv_gcp_bbbbbb');
    expect(a).not.toBe(b);
    expect(a).toBe('my-box-aaaaaa');
  });

  it('falls back to the serverId when the label slugs to nothing', () => {
    const name = toProviderResourceName('🚀🚀🚀', 'srv_gcp_ab12cd');
    expect(name).toBe('srv-gcp-ab12cd');
    expect(name).toMatch(RFC1035);
  });

  it('forces a leading letter when the label starts with a digit', () => {
    const name = toProviderResourceName('2nd box', 'srv_gcp_ab12cd');
    expect(name).toMatch(RFC1035);
    expect(name.startsWith('s-')).toBe(true);
  });

  it('never exceeds 63 chars and never ends on a hyphen after trimming', () => {
    const name = toProviderResourceName('x'.repeat(80), 'srv_gcp_ab12cd');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith('-')).toBe(false);
    expect(name).toMatch(RFC1035);
  });

  it('produces a valid name for every plausible operator label', () => {
    const labels = [
      'Google GCP Free trial 1',
      'hetzner-fsn-1',
      'Oracle (Frankfurt) — free tier!',
      'EC2 (main)',
      '   spaced   out   ',
      'UPPER_CASE_BOX',
      'box.with.dots',
      '1',
    ];
    for (const label of labels) {
      expect(toProviderResourceName(label, 'srv_gcp_ab12cd')).toMatch(RFC1035);
    }
  });
});
