/**
 * integrations-manifest-schema.test.ts — Pipeline v2 Phase 2-D / Story 2-D-3-1 (PR-89).
 */

import { describe, it, expect } from 'vitest';
import {
  IntegrationsManifestSchema,
  emptyIntegrationsManifest,
  effectiveRotationCadence,
  resolveSecretPath,
} from '../integrations-manifest-schema';

describe('IntegrationsManifestSchema', () => {
  it('parses the empty scaffold', () => {
    expect(
      IntegrationsManifestSchema.safeParse(emptyIntegrationsManifest('songster')).success,
    ).toBe(true);
  });

  it('parses the v2.5 §26 Moises illustrative entry', () => {
    const manifest = {
      project: 'songster',
      'manifest-version': 1,
      'rotation-cadence-default': '90d',
      integrations: [
        {
          id: 'moises-api',
          vendor: 'moises.ai',
          purpose: 'stem separation, chord detection',
          'rigor-min': 'mvp',
          'secret-path': '/futurator/songster/{env}/moises-api/api-key',
          'rotation-cadence': '90d',
          endpoints: {
            dev: 'https://api.moises.ai/sandbox/v1',
            production: 'https://api.moises.ai/v1',
          },
        },
      ],
    };
    expect(IntegrationsManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects bad secret-path shape', () => {
    const m = {
      project: 'x',
      'manifest-version': 1,
      'rotation-cadence-default': '90d',
      integrations: [
        {
          id: 'bad-id',
          vendor: 'v',
          purpose: 'p',
          'secret-path': '/some/non-standard/path',
          endpoints: {},
        },
      ],
    };
    expect(IntegrationsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects bad id slug', () => {
    const m = {
      project: 'x',
      'manifest-version': 1,
      'rotation-cadence-default': '90d',
      integrations: [
        {
          id: 'Bad-Case',
          vendor: 'v',
          purpose: 'p',
          'secret-path': '/futurator/x/{env}/svc/key',
          endpoints: {},
        },
      ],
    };
    expect(IntegrationsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects bad rotation-cadence', () => {
    const m = {
      project: 'x',
      'manifest-version': 1,
      'rotation-cadence-default': 'fortnightly',
      integrations: [],
    };
    expect(IntegrationsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('accepts arbitrary passthrough fields on integration body', () => {
    const m = {
      project: 'x',
      'manifest-version': 1,
      'rotation-cadence-default': '90d',
      integrations: [
        {
          id: 'stripe',
          vendor: 'stripe',
          purpose: 'payments',
          'secret-path': '/futurator/x/{env}/stripe/api-key',
          endpoints: {},
          // arbitrary vendor-specific fields
          'webhook-secret-path': '/futurator/x/{env}/stripe/webhook-secret',
          'api-version': '2025-09-30.acacia',
        },
      ],
    };
    expect(IntegrationsManifestSchema.safeParse(m).success).toBe(true);
  });

  it('accepts webhook block', () => {
    const m = {
      project: 'x',
      'manifest-version': 1,
      'rotation-cadence-default': '90d',
      integrations: [
        {
          id: 'stripe',
          vendor: 'stripe',
          purpose: 'payments',
          'secret-path': '/futurator/x/{env}/stripe/api-key',
          endpoints: {},
          webhook: {
            path: '/api/webhooks/stripe',
            events: ['checkout.session.completed'],
            'signature-header': 'stripe-signature',
          },
        },
      ],
    };
    expect(IntegrationsManifestSchema.safeParse(m).success).toBe(true);
  });

  it('defaults rotation-cadence-default to 90d', () => {
    const m = { project: 'x', 'manifest-version': 1, integrations: [] };
    const result = IntegrationsManifestSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data['rotation-cadence-default']).toBe('90d');
  });
});

describe('effectiveRotationCadence', () => {
  const manifest = emptyIntegrationsManifest('x');
  manifest['rotation-cadence-default'] = '90d';

  it('uses manifest default when integration has no override', () => {
    const integration = {
      id: 'a',
      vendor: 'v',
      purpose: 'p',
      'rigor-min': 'mvp' as const,
      'secret-path': '/futurator/x/{env}/svc/k',
      endpoints: {},
    };
    expect(effectiveRotationCadence(integration, manifest)).toBe('90d');
  });

  it('uses integration override when present', () => {
    const integration = {
      id: 'a',
      vendor: 'v',
      purpose: 'p',
      'rigor-min': 'mvp' as const,
      'secret-path': '/futurator/x/{env}/svc/k',
      'rotation-cadence': '30d' as const,
      endpoints: {},
    };
    expect(effectiveRotationCadence(integration, manifest)).toBe('30d');
  });
});

describe('resolveSecretPath', () => {
  it('expands {env} placeholder', () => {
    expect(resolveSecretPath('/futurator/x/{env}/svc/k', 'production')).toBe(
      '/futurator/x/production/svc/k',
    );
  });

  it('expands multiple occurrences', () => {
    expect(resolveSecretPath('{env}/{env}', 'dev')).toBe('dev/dev');
  });

  it('no-op when template has no placeholder', () => {
    expect(resolveSecretPath('/static/path', 'dev')).toBe('/static/path');
  });
});
