import type { ComputeProviderId, ServerServiceType } from '../../types/compute-server';

export interface ProviderServiceTypeCatalogEntry {
  type: ServerServiceType;
  label: string;
  available: boolean;
  note?: string;
}

export interface ProviderCatalogEntry {
  provider: ComputeProviderId;
  label: string;
  serviceTypes: ProviderServiceTypeCatalogEntry[];
  defaultRegions: string[];
  defaultSizes: string[];
}

/**
 * Static provider catalog for the Servers module fleet wizard (spec §4.1,
 * §7 `GET /api/servers/providers`). `available: false` service types render
 * greyed-out in the UI — they are catalogued but not creatable in v1.
 */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    provider: 'hetzner',
    label: 'Hetzner Cloud',
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    defaultRegions: ['fsn1', 'nbg1'],
    defaultSizes: ['cax11', 'cx22'],
  },
  {
    provider: 'oracle',
    label: 'Oracle Cloud Infrastructure',
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    defaultRegions: ['eu-frankfurt-1'],
    defaultSizes: ['VM.Standard.A1.Flex'],
  },
  {
    provider: 'gcp',
    label: 'Google Cloud Platform',
    serviceTypes: [
      { type: 'vm', label: 'Virtual machine', available: true },
      {
        type: 'serverless',
        label: 'Serverless',
        available: false,
        note: 'Cloud Run Jobs — coming in v2',
      },
    ],
    defaultRegions: ['europe-west3'],
    defaultSizes: ['e2-small', 'e2-medium'],
  },
  {
    provider: 'aws',
    label: 'Amazon Web Services',
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    defaultRegions: [],
    defaultSizes: [],
  },
  {
    provider: 'local',
    label: 'Local machine',
    serviceTypes: [{ type: 'local-machine', label: 'Local machine', available: true }],
    defaultRegions: [],
    defaultSizes: [],
  },
];
