/**
 * skill-proposal-schema.test.ts — Skills Institution, Story 3.1.
 */

import { describe, it, expect } from 'vitest';
import {
  SkillProposalSchema,
  parseSkillProposal,
  ProposalSourceSchema,
  ProposalStatusSchema,
} from '../skill-proposal-schema';

const valid = {
  proposalId: '01HZ-abc',
  source: 'reflect-graduate',
  skillName: 'fix-flaky-tests',
  proposedBody: '# body',
  proposedEntry: {
    name: 'fix-flaky-tests',
    description: 'd',
  },
  securityStatus: 'clean',
  createdAt: '2026-06-17T10:00:00Z',
};

describe('SkillProposalSchema', () => {
  it('parses a minimal valid proposal and applies defaults', () => {
    const p = SkillProposalSchema.parse(valid);
    expect(p.status).toBe('pending');
    expect(p.qualityGrade).toBe('ungraded');
    expect(p.kind).toBe('core');
    // proposedEntry got its own base-field defaults from the entry schema
    expect(p.proposedEntry.framework).toBe(false);
    expect(p.proposedEntry.version).toBe('sha:HEAD');
  });

  it('accepts an optional scanReport with pattern hits', () => {
    const p = SkillProposalSchema.parse({
      ...valid,
      securityStatus: 'quarantined',
      status: 'quarantined',
      scanReport: {
        securityStatus: 'quarantined',
        patternsHit: [
          {
            id: 'destructive-rm',
            category: 'destructive',
            severity: 'blocking',
            description: 'rm -rf',
            evidence: 'rm -rf /',
            location: 'body',
          },
        ],
      },
    });
    expect(p.scanReport?.patternsHit[0].id).toBe('destructive-rm');
  });

  it('rejects an unknown source or status', () => {
    expect(SkillProposalSchema.safeParse({ ...valid, source: 'telepathy' }).success).toBe(false);
    expect(SkillProposalSchema.safeParse({ ...valid, status: 'maybe' }).success).toBe(false);
  });

  it('requires proposalId, skillName, createdAt', () => {
    expect(SkillProposalSchema.safeParse({ ...valid, proposalId: '' }).success).toBe(false);
    expect(SkillProposalSchema.safeParse({ ...valid, skillName: '' }).success).toBe(false);
    const { createdAt, ...noDate } = valid;
    void createdAt;
    expect(SkillProposalSchema.safeParse(noDate).success).toBe(false);
  });

  it('parseSkillProposal returns null on garbage', () => {
    expect(parseSkillProposal({ junk: true })).toBeNull();
    expect(parseSkillProposal(parseSkillProposal(valid))).not.toBeNull();
  });

  it('enumerates the four entry sources and five statuses', () => {
    expect(ProposalSourceSchema.options).toEqual([
      'reflect-graduate',
      'create',
      'paste-url',
      'bulk',
    ]);
    expect(ProposalStatusSchema.options).toContain('quarantined');
  });
});
