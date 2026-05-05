import type {
  CharacterId,
  CharacterKind,
  CharacterLook,
  HatKind,
  Persona,
  PersonaRole,
  SeatRef,
} from './types';

// ── Asset roots ──

export const CHARS_URL = '/models/universal-gltf';
export const FURN_URL = '/models/environment/furniture';
export const RESTAURANT_URL = '/models/environment/restaurant';

export const modelUrlForKind = (k: CharacterKind) => `${CHARS_URL}/${k}.gltf`;

// ── Outfits we actually ship ──

export const CHARACTER_KINDS: readonly CharacterKind[] = [
  'Suit_Male',
  'Suit_Female',
  'Casual_Male',
  'Casual_Female',
  'Casual2_Male',
  'Casual3_Male',
  'Casual3_Female',
  'Casual_Bald',
  'Worker_Male',
  'Worker_Female',
] as const;

// ── Palettes for appearance customization ──

export const SKIN_COLORS = [
  '#fbe1c4',
  '#f4c1a3',
  '#e0a878',
  '#c08868',
  '#8d5b3a',
  '#6f3f24',
  '#4f2a13',
  '#ffd2b1',
] as const;

export const HAIR_COLORS = [
  '#0a0a0a',
  '#3a2a1a',
  '#6b4423',
  '#a46c2b',
  '#d4a05a',
  '#e6c98a',
  '#b91c1c',
  '#6d28d9',
  '#94a3b8',
  '#f1f5f9',
] as const;

export const CLOTH_COLORS = [
  '#1e3a8a',
  '#1e40af',
  '#0ea5e9',
  '#14b8a6',
  '#16a34a',
  '#eab308',
  '#f97316',
  '#dc2626',
  '#be185d',
  '#a855f7',
  '#334155',
  '#0f172a',
  '#f8fafc',
  '#f5f5dc',
  '#6b4423',
  '#000000',
] as const;

export const HAT_KINDS: readonly HatKind[] = ['none', 'cap', 'tophat', 'beanie', 'headphones'];

// ── Seat slot plan ──
// desk-0..3  = dev desks (Bob/Carol/Dave/Eve home)
// desk-4..7  = reviewer desks (Frank/Joseph/Sonia/Manuel home)
// desk-8..11 = tester desks (Nadia/Olaf/Priya/Quinn home, lab-coat tint)
// whiteboard-0 = Milena's stand
// supervisor-0 = Ricardo's desk

const deskSeat = (slot: number): SeatRef => ({ kind: 'desk', slot });

export const DEV_DESK_SLOTS = [0, 1, 2, 3] as const;
export const REVIEWER_DESK_SLOTS = [4, 5, 6, 7] as const;
export const TESTER_DESK_SLOTS = [8, 9, 10, 11] as const;

// ── Named cast ──
// Role assignment is IMMUTABLE: Milena is always PM, Ricardo always
// orchestrator, Bob..Eve are always devs, Frank..Manuel are always
// reviewers. Running stories are mapped onto these personas; if every dev
// is busy, new stories sit in the `queued` column.

function look(
  kind: CharacterKind,
  opts: Partial<Pick<CharacterLook, 'hair' | 'shirt' | 'pants' | 'hat' | 'hatColor' | 'skin'>> = {},
): CharacterLook {
  return {
    kind,
    skin: opts.skin ?? '#f4c1a3',
    hair: opts.hair ?? '#3a2a1a',
    shirt: opts.shirt ?? '#1e40af',
    pants: opts.pants ?? '#0f172a',
    hat: opts.hat ?? 'none',
    hatColor: opts.hatColor ?? '#0a0a0a',
  };
}

export const CAST: readonly Persona[] = [
  // PM
  {
    id: 'milena',
    name: 'Milena',
    role: 'pm',
    homeSeat: { kind: 'whiteboard', slot: 0 },
    look: look('Suit_Female', { shirt: '#c77dff', hair: '#3a2a1a' }),
  },
  // Orchestrator
  {
    id: 'ricardo',
    name: 'Ricardo',
    role: 'orchestrator',
    homeSeat: { kind: 'supervisor', slot: 0 },
    look: look('Casual_Bald', { shirt: '#fbbf24', pants: '#1e3a8a' }),
  },
  // Developers
  {
    id: 'bob',
    name: 'Bob',
    role: 'developer',
    homeSeat: deskSeat(0),
    look: look('Suit_Male', { shirt: '#4cc9f0' }),
  },
  {
    id: 'carol',
    name: 'Carol',
    role: 'developer',
    homeSeat: deskSeat(1),
    look: look('Casual_Female', { shirt: '#80ed99', hair: '#6b4423' }),
  },
  {
    id: 'dave',
    name: 'Dave',
    role: 'developer',
    homeSeat: deskSeat(2),
    look: look('Casual_Male', { shirt: '#3b82f6' }),
  },
  {
    id: 'eve',
    name: 'Eve',
    role: 'developer',
    homeSeat: deskSeat(3),
    look: look('Worker_Female', { shirt: '#06b6d4', hair: '#b91c1c' }),
  },
  // Reviewers
  {
    id: 'frank',
    name: 'Frank',
    role: 'reviewer',
    homeSeat: deskSeat(4),
    look: look('Worker_Male', { shirt: '#ef476f' }),
  },
  {
    id: 'joseph',
    name: 'Joseph',
    role: 'reviewer',
    homeSeat: deskSeat(5),
    look: look('Casual2_Male', { shirt: '#fb7185' }),
  },
  {
    id: 'sonia',
    name: 'Sonia',
    role: 'reviewer',
    homeSeat: deskSeat(6),
    look: look('Casual3_Female', { shirt: '#fb923c', hair: '#a46c2b' }),
  },
  {
    id: 'manuel',
    name: 'Manuel',
    role: 'reviewer',
    homeSeat: deskSeat(7),
    look: look('Casual3_Male', { shirt: '#dc2626' }),
  },
  // Testers — lab-coat tint (off-white shirt), home at desks 8..11.
  {
    id: 'nadia',
    name: 'Nadia',
    role: 'tester',
    homeSeat: deskSeat(8),
    look: look('Casual_Female', { shirt: '#f1f5f9', pants: '#0f172a', hair: '#3a2a1a' }),
  },
  {
    id: 'olaf',
    name: 'Olaf',
    role: 'tester',
    homeSeat: deskSeat(9),
    look: look('Suit_Male', { shirt: '#f1f5f9', pants: '#0f172a', hair: '#d4a05a' }),
  },
  {
    id: 'priya',
    name: 'Priya',
    role: 'tester',
    homeSeat: deskSeat(10),
    look: look('Casual3_Female', { shirt: '#f1f5f9', pants: '#0f172a', hair: '#0a0a0a' }),
  },
  {
    id: 'quinn',
    name: 'Quinn',
    role: 'tester',
    homeSeat: deskSeat(11),
    look: look('Casual2_Male', { shirt: '#f1f5f9', pants: '#0f172a', hair: '#6b4423' }),
  },
] as const;

export const CAST_BY_ID: Record<CharacterId, Persona> = CAST.reduce(
  (acc, p) => ({ ...acc, [p.id]: p }),
  {} as Record<CharacterId, Persona>,
);

export function personasByRole(role: PersonaRole): readonly Persona[] {
  return CAST.filter((p) => p.role === role);
}

export const DEV_POOL: readonly CharacterId[] = personasByRole('developer').map((p) => p.id);
export const REVIEWER_POOL: readonly CharacterId[] = personasByRole('reviewer').map((p) => p.id);
export const TESTER_POOL: readonly CharacterId[] = personasByRole('tester').map((p) => p.id);
export const MAX_DEV_CAPACITY = DEV_POOL.length;
export const MAX_REVIEWER_CAPACITY = REVIEWER_POOL.length;
export const MAX_TESTER_CAPACITY = TESTER_POOL.length;
