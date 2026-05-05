export interface AgentIdentity {
  icon: string;
  accent: string;
  accentHex: string;
  bg: string;
  title?: string;
}

const IDENTITIES: Record<string, AgentIdentity> = {
  'bmad master': {
    icon: '🧙',
    accent: 'text-violet-400',
    accentHex: '#a78bfa',
    bg: 'rgba(167,139,250,0.12)',
    title: 'Orchestrator',
  },
  master: {
    icon: '🧙',
    accent: 'text-violet-400',
    accentHex: '#a78bfa',
    bg: 'rgba(167,139,250,0.12)',
    title: 'Orchestrator',
  },
  'bmad builder': {
    icon: '🧙',
    accent: 'text-violet-400',
    accentHex: '#a78bfa',
    bg: 'rgba(167,139,250,0.12)',
    title: 'BMad Builder',
  },
  mary: {
    icon: '📊',
    accent: 'text-blue-400',
    accentHex: '#60a5fa',
    bg: 'rgba(96,165,250,0.12)',
    title: 'Business Analyst',
  },
  winston: {
    icon: '🏗️',
    accent: 'text-amber-400',
    accentHex: '#fbbf24',
    bg: 'rgba(251,191,36,0.12)',
    title: 'Architect',
  },
  amelia: {
    icon: '💻',
    accent: 'text-emerald-400',
    accentHex: '#34d399',
    bg: 'rgba(52,211,153,0.12)',
    title: 'Developer',
  },
  john: {
    icon: '📋',
    accent: 'text-sky-400',
    accentHex: '#38bdf8',
    bg: 'rgba(56,189,248,0.12)',
    title: 'Product Manager',
  },
  bob: {
    icon: '🏃',
    accent: 'text-orange-400',
    accentHex: '#fb923c',
    bg: 'rgba(251,146,60,0.12)',
    title: 'Scrum Master',
  },
  murat: {
    icon: '🧪',
    accent: 'text-fuchsia-400',
    accentHex: '#e879f9',
    bg: 'rgba(232,121,249,0.12)',
    title: 'Test Architect',
  },
  paige: {
    icon: '📚',
    accent: 'text-cyan-400',
    accentHex: '#22d3ee',
    bg: 'rgba(34,211,238,0.12)',
    title: 'Technical Writer',
  },
  sally: {
    icon: '🎨',
    accent: 'text-pink-400',
    accentHex: '#f472b6',
    bg: 'rgba(244,114,182,0.12)',
    title: 'UX Designer',
  },
  carson: {
    icon: '🧠',
    accent: 'text-yellow-400',
    accentHex: '#facc15',
    bg: 'rgba(250,204,21,0.12)',
    title: 'Brainstorming Coach',
  },
  'dr. quinn': {
    icon: '🔬',
    accent: 'text-teal-400',
    accentHex: '#2dd4bf',
    bg: 'rgba(45,212,191,0.12)',
    title: 'Problem Solver',
  },
  maya: {
    icon: '🎨',
    accent: 'text-rose-400',
    accentHex: '#fb7185',
    bg: 'rgba(251,113,133,0.12)',
    title: 'Design Thinking',
  },
  victor: {
    icon: '⚡',
    accent: 'text-yellow-500',
    accentHex: '#eab308',
    bg: 'rgba(234,179,8,0.12)',
    title: 'Innovation Strategist',
  },
  sophia: {
    icon: '📖',
    accent: 'text-indigo-400',
    accentHex: '#818cf8',
    bg: 'rgba(129,140,248,0.12)',
    title: 'Storyteller',
  },
  ludwig: {
    icon: '🎼',
    accent: 'text-purple-400',
    accentHex: '#c084fc',
    bg: 'rgba(192,132,252,0.12)',
    title: 'Orchestration',
  },
  pedrock: {
    icon: '🪨',
    accent: 'text-stone-400',
    accentHex: '#a8a29e',
    bg: 'rgba(168,162,158,0.12)',
    title: 'AWS Bedrock',
  },
  'dave ups!': {
    icon: '🔥',
    accent: 'text-red-400',
    accentHex: '#f87171',
    bg: 'rgba(248,113,113,0.12)',
    title: 'AWS DevOps',
  },
  'sean tinel': {
    icon: '🔒',
    accent: 'text-lime-400',
    accentHex: '#a3e635',
    bg: 'rgba(163,230,53,0.12)',
    title: 'AWS Security',
  },
  nimbus: {
    icon: '☁️',
    accent: 'text-sky-300',
    accentHex: '#7dd3fc',
    bg: 'rgba(125,211,252,0.12)',
    title: 'AWS Solutions Architect',
  },
  'kube rick': {
    icon: '🚢',
    accent: 'text-blue-300',
    accentHex: '#93c5fd',
    bg: 'rgba(147,197,253,0.12)',
    title: 'Containers',
  },
  'sue render': {
    icon: '⚡',
    accent: 'text-pink-300',
    accentHex: '#f9a8d4',
    bg: 'rgba(249,168,212,0.12)',
    title: 'Animation',
  },
  rick: {
    icon: '🧪',
    accent: 'text-green-400',
    accentHex: '#4ade80',
    bg: 'rgba(74,222,128,0.12)',
    title: 'Innovation Disruptor',
  },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const DEFAULT: AgentIdentity = {
  icon: '',
  accent: 'text-muted-foreground',
  accentHex: '#a3a3a3',
  bg: 'rgba(163,163,163,0.12)',
  title: undefined,
};

export function agentIdentity(speaker: string): AgentIdentity & {
  fallbackInitials: string;
  displayName: string;
} {
  const key = speaker.trim().toLowerCase();
  const match = IDENTITIES[key];
  const identity = match ?? DEFAULT;
  return {
    ...identity,
    fallbackInitials: initials(speaker),
    displayName: speaker,
  };
}
