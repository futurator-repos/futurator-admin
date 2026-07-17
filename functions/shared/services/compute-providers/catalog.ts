import type { ComputeProviderId, ServerServiceType } from '../../types/compute-server';

/**
 * Servers module — provider catalog (spec §4.1, §7 `GET /api/servers/providers`).
 *
 * This is the single source of truth the Add-Server wizard renders from: which
 * providers can actually be provisioned, what credentials each one needs (and
 * where the operator finds them), which shapes exist, what they cost, and which
 * architecture each shape implies. The backend provisioner validates against the
 * same entries, so the UI cannot offer something the adapters can't build.
 */

export type CredentialFieldKind = 'text' | 'password' | 'textarea' | 'list';

export interface ProviderCredentialField {
  /** Must match the key in `providerCredentialsSchema` for this provider. */
  name: string;
  label: string;
  kind: CredentialFieldKind;
  placeholder?: string;
  /** Operator-facing "where do I get this" guidance, rendered under the field. */
  help?: string;
}

export interface ProviderRegionOption {
  value: string;
  label: string;
}

export interface ProviderSizeOption {
  value: string;
  label: string;
  /** Authoritative: cloud-init and the provisioner derive arch from the shape. */
  arch: 'arm64' | 'x86_64';
  vcpu: number;
  memGB: number;
  /** Estimate in USD/hr — seeds the form; the operator can correct it. */
  costPerHour: number;
  note?: string;
}

export interface ProviderServiceTypeCatalogEntry {
  type: ServerServiceType;
  label: string;
  available: boolean;
  note?: string;
}

export interface ProviderCatalogEntry {
  provider: ComputeProviderId;
  label: string;
  summary: string;
  /** False ⇒ the wizard must not offer it and `provisionServer` rejects it. */
  creatable: boolean;
  /** Why it is not creatable (rendered on the disabled card). */
  unavailableNote?: string;
  /** False for local/aws — no secret material to store. */
  requiresCredentials: boolean;
  credentialFields: ProviderCredentialField[];
  credentialsHelpUrl?: string;
  serviceTypes: ProviderServiceTypeCatalogEntry[];
  /**
   * Where the VM's location comes from:
   *  - 'server'      — per-server choice; the adapter honours `spec.region`.
   *  - 'credentials' — fixed by the stored credentials (Oracle `region`, GCP
   *    `zone`); the wizard must NOT ask, and the provisioner stamps the row
   *    from the credentials so the fleet card can't lie about placement.
   *  - 'none'        — local machines.
   */
  regionSource: 'server' | 'credentials' | 'none';
  regions: ProviderRegionOption[];
  sizes: ProviderSizeOption[];
  defaultMaxConcurrent: number;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    provider: 'oracle',
    label: 'Oracle Cloud Infrastructure',
    summary: 'Always Free ARM (2 OCPU / 12 GB) in Frankfurt — $0/mo, capacity permitting.',
    creatable: true,
    requiresCredentials: true,
    credentialsHelpUrl: 'https://cloud.oracle.com',
    credentialFields: [
      {
        name: 'tenancyOcid',
        label: 'Tenancy OCID',
        kind: 'text',
        placeholder: 'ocid1.tenancy.oc1..aaaa…',
        help: 'Profile menu (top-right) → Tenancy: <name> → copy OCID.',
      },
      {
        name: 'userOcid',
        label: 'User OCID',
        kind: 'text',
        placeholder: 'ocid1.user.oc1..aaaa…',
        help: 'Profile menu → My profile → copy OCID.',
      },
      {
        name: 'fingerprint',
        label: 'API key fingerprint',
        kind: 'text',
        placeholder: 'aa:bb:cc:dd:…',
        help: 'My profile → API keys → Add API key → Generate key pair → Download private key → Add. The fingerprint is shown after adding.',
      },
      {
        name: 'privateKeyPem',
        label: 'API private key (PEM)',
        kind: 'textarea',
        placeholder: '-----BEGIN PRIVATE KEY-----',
        help: 'Paste the whole downloaded .pem, including the BEGIN/END lines.',
      },
      {
        name: 'compartmentId',
        label: 'Compartment OCID',
        kind: 'text',
        placeholder: 'ocid1.compartment.oc1..aaaa… (or the tenancy OCID)',
        help: 'Identity → Compartments. The tenancy OCID (root compartment) works fine for a single operator.',
      },
      {
        name: 'region',
        label: 'Region',
        kind: 'text',
        placeholder: 'eu-frankfurt-1',
        help: 'Your home region — Always Free resources only exist there. Shown in the console top bar.',
      },
      {
        name: 'imageId',
        label: 'Ubuntu 24.04 ARM image OCID',
        kind: 'text',
        placeholder: 'ocid1.image.oc1.eu-frankfurt-1.aaaa…',
        help: 'Compute → Instances → Create instance → pick Canonical Ubuntu 24.04 with shape VM.Standard.A1.Flex → open the image details for its OCID (name contains aarch64), then cancel the form.',
      },
      {
        name: 'availabilityDomains',
        label: 'Availability domains',
        kind: 'list',
        placeholder: 'Abcd:EU-FRANKFURT-1-AD-1',
        help: 'One per line. Frankfurt has three — enter all of them: free ARM capacity is scarce and the provisioner retries each AD in turn.',
      },
    ],
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    regionSource: 'credentials',
    regions: [{ value: 'eu-frankfurt-1', label: 'Frankfurt (eu-frankfurt-1)' }],
    sizes: [
      {
        value: 'VM.Standard.A1.Flex',
        label: 'VM.Standard.A1.Flex — Ampere ARM',
        arch: 'arm64',
        vcpu: 2,
        memGB: 12,
        costPerHour: 0,
        note: 'Always Free ceiling (halved June 2026). "Out of host capacity" is common — retry.',
      },
    ],
    defaultMaxConcurrent: 2,
  },
  {
    provider: 'hetzner',
    label: 'Hetzner Cloud',
    summary: 'Cheap EU ARM/x86 VMs. Billed while stopped — destroy, never pause.',
    creatable: true,
    requiresCredentials: true,
    credentialsHelpUrl: 'https://console.hetzner.cloud',
    credentialFields: [
      {
        name: 'token',
        label: 'API token',
        kind: 'password',
        placeholder: 'Hetzner Cloud API token',
        help: 'Cloud Console → your project → Security → API tokens → Generate API token (Read & Write).',
      },
    ],
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    regionSource: 'server',
    regions: [
      { value: 'fsn1', label: 'Falkenstein, DE (fsn1)' },
      { value: 'nbg1', label: 'Nuremberg, DE (nbg1)' },
      { value: 'hel1', label: 'Helsinki, FI (hel1)' },
    ],
    sizes: [
      {
        value: 'cax11',
        label: 'CAX11 — Ampere ARM',
        arch: 'arm64',
        vcpu: 2,
        memGB: 4,
        costPerHour: 0.006,
        note: '≈ €4/mo — the cheapest box that runs the daemon comfortably.',
      },
      {
        value: 'cax21',
        label: 'CAX21 — Ampere ARM',
        arch: 'arm64',
        vcpu: 4,
        memGB: 8,
        costPerHour: 0.01,
        note: '≈ €7/mo — headroom for cap 3–4.',
      },
      {
        value: 'cx22',
        label: 'CX22 — Intel x86',
        arch: 'x86_64',
        vcpu: 2,
        memGB: 4,
        costPerHour: 0.006,
        note: 'x86 only if something in the toolchain refuses ARM.',
      },
    ],
    defaultMaxConcurrent: 2,
  },
  {
    provider: 'gcp',
    label: 'Google Cloud Platform',
    summary: '$300 trial credit. The only provider that can Stop/Start to pause billing.',
    creatable: true,
    requiresCredentials: true,
    credentialsHelpUrl: 'https://console.cloud.google.com',
    credentialFields: [
      {
        name: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        kind: 'textarea',
        placeholder: '{ "type": "service_account", … }',
        help: 'IAM & Admin → Service accounts → create one with the "Compute Admin" role → Keys → Add key → JSON. Paste the whole file.',
      },
      {
        name: 'projectId',
        label: 'Project ID',
        kind: 'text',
        placeholder: 'my-project-123456',
        help: 'The project ID (not its display name) — shown in the console project picker.',
      },
      {
        name: 'zone',
        label: 'Zone',
        kind: 'text',
        placeholder: 'europe-west3-a',
        help: 'Every VM from these credentials is created here. Frankfurt = europe-west3-a.',
      },
    ],
    serviceTypes: [
      { type: 'vm', label: 'Virtual machine', available: true },
      {
        type: 'serverless',
        label: 'Serverless',
        available: false,
        note: 'Cloud Run Jobs — coming in v2',
      },
    ],
    regionSource: 'credentials',
    regions: [
      { value: 'europe-west3-a', label: 'Frankfurt (europe-west3-a)' },
      { value: 'europe-west3-b', label: 'Frankfurt (europe-west3-b)' },
    ],
    sizes: [
      {
        value: 'e2-small',
        label: 'e2-small',
        arch: 'x86_64',
        vcpu: 2,
        memGB: 2,
        costPerHour: 0.019,
        note: '2 GB is tight for parallel agents — cap 1.',
      },
      {
        value: 'e2-medium',
        label: 'e2-medium',
        arch: 'x86_64',
        vcpu: 2,
        memGB: 4,
        costPerHour: 0.038,
      },
    ],
    defaultMaxConcurrent: 1,
  },
  {
    provider: 'local',
    label: 'Local machine',
    summary: 'Your Mac or any box you already own — enrolled with a one-time install command.',
    creatable: true,
    requiresCredentials: false,
    credentialFields: [],
    serviceTypes: [{ type: 'local-machine', label: 'Local machine', available: true }],
    regionSource: 'none',
    regions: [],
    sizes: [],
    defaultMaxConcurrent: 2,
  },
  {
    provider: 'aws',
    label: 'Amazon Web Services',
    summary: 'The existing EC2 daemon box.',
    creatable: false,
    unavailableNote:
      'EC2 instances are declared as IaC in sst.config.ts, not provisioned here. The existing box is already in the fleet as srv_ec2_main.',
    requiresCredentials: false,
    credentialFields: [],
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: false }],
    regionSource: 'none',
    regions: [],
    sizes: [],
    defaultMaxConcurrent: 2,
  },
];

export function getCatalogEntry(provider: ComputeProviderId): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.provider === provider);
}

/** The shape's arch is authoritative — a cax11 built as x86_64 boots broken. */
export function getCatalogSize(
  provider: ComputeProviderId,
  size: string,
): ProviderSizeOption | undefined {
  return getCatalogEntry(provider)?.sizes.find((s) => s.value === size);
}
