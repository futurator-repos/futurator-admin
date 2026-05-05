/* global React */
// Shared data for Party Mode mockup: agents, projects, and demo conversations.

const AGENTS = {
  mary:    { icon: '📊', name: 'Mary',    role: 'Business Analyst',   accent: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  john:    { icon: '📋', name: 'John',    role: 'Product Manager',    accent: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
  sally:   { icon: '🎨', name: 'Sally',   role: 'UX Designer',        accent: '#f472b6', bg: 'rgba(244,114,182,0.12)' },
  winston: { icon: '🏗️', name: 'Winston', role: 'Architect',          accent: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  amelia:  { icon: '💻', name: 'Amelia',  role: 'Developer',          accent: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  paige:   { icon: '📚', name: 'Paige',   role: 'Technical Writer',   accent: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
  bob:     { icon: '🏃', name: 'Bob',     role: 'Scrum Master',       accent: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  murat:   { icon: '🧪', name: 'Murat',   role: 'Test Architect',     accent: '#e879f9', bg: 'rgba(232,121,249,0.12)' },
  carson:  { icon: '🧠', name: 'Carson',  role: 'Brainstorm Coach',   accent: '#facc15', bg: 'rgba(250,204,21,0.12)' },
  master:  { icon: '🧙', name: 'BMad Master', role: 'Orchestrator',   accent: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
};

function agent(key) {
  return AGENTS[key.toLowerCase()] || {
    icon: '●', name: key, role: '', accent: '#a3a3a3', bg: 'rgba(163,163,163,0.12)',
  };
}

// Fallback initials for agents without icons
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const PROJECTS = [
  {
    id: 'solitaire',
    path: '/home/ubuntu/projects/solitaire',
    status: 'HEALTHY',
    bmadVersion: '6.3.0',
    agents: 6,
    totalAgents: 6,
    inspectedAgo: '15h ago',
    sizeKb: 2840,
    lastActivity: '2m ago',
    sessions: 3,
  },
  {
    id: 'quill',
    path: '/home/ubuntu/projects/quill',
    status: 'HEALTHY',
    bmadVersion: '6.3.0',
    agents: 23,
    totalAgents: 23,
    inspectedAgo: '2h ago',
    sizeKb: 18400,
    lastActivity: '1d ago',
    sessions: 12,
  },
  {
    id: 'atlas-cli',
    path: '/home/ubuntu/projects/atlas-cli',
    status: 'DRIFTED',
    bmadVersion: '6.2.1',
    agents: 19,
    totalAgents: 23,
    inspectedAgo: '3d ago',
    sizeKb: 9240,
    lastActivity: '4d ago',
    sessions: 1,
  },
  {
    id: 'futurator-web',
    path: '/home/ubuntu/projects/futurator-web',
    status: 'HEALTHY',
    bmadVersion: '6.3.0',
    agents: 23,
    totalAgents: 23,
    inspectedAgo: '40m ago',
    sizeKb: 52100,
    lastActivity: '12m ago',
    sessions: 28,
  },
  {
    id: 'lemma',
    path: '/home/ubuntu/projects/lemma',
    status: 'INSTALLING',
    bmadVersion: null,
    agents: null,
    totalAgents: 23,
    inspectedAgo: 'now',
    sizeKb: 1240,
    lastActivity: 'just now',
    sessions: 0,
  },
  {
    id: 'prism-sdk',
    path: '/home/ubuntu/projects/prism-sdk',
    status: 'FAILED',
    bmadVersion: null,
    agents: null,
    totalAgents: 23,
    inspectedAgo: '1h ago',
    sizeKb: 840,
    failureReason: 'bmad install: pnpm ETARGET',
    lastActivity: '1h ago',
    sessions: 0,
  },
  {
    id: 'nebula',
    path: '/home/ubuntu/projects/nebula',
    status: 'MISSING',
    bmadVersion: null,
    agents: null,
    totalAgents: 23,
    inspectedAgo: '—',
    sizeKb: 0,
    lastActivity: '—',
    sessions: 0,
  },
];

// Rich example conversation. Each message has a speaker (or 'user' / 'system') and content in mini-markdown.
const DEMO_MESSAGES = [
  { kind: 'user', turn: 1, content: "I want to create a scoring system for this game, let's debate on that." },
  { kind: 'system', turn: 1, content: "Let me get a quick look at the project to give agents proper context. Welcome to **Party Mode**, Ubuntu! 🎉" },
  { kind: 'system', turn: 1, content: "Here's your roundtable roster — the BMAD agents available for discussion:",
    roster: true,
  },
  { kind: 'system', turn: 1, content: "Great topic — a scoring system for a solitaire game has a lot of interesting design surface. Let me pull in the agents best suited: **John** (what makes a scoring system valuable), **Sally** (how scoring feels and motivates), **Mary** (what competitive solitaire games do), and **Winston** (how to architect it cleanly)." },
  { kind: 'system', turn: 1, content: "Spawning them now…" },

  { kind: 'agent', speaker: 'mary', turn: 1, content: `Excellent — I'm genuinely excited to dig into this because scoring systems are where player behavior gets engineered. Before we debate approaches, I need to understand what we're actually optimizing for.

**1. What's the core purpose of scoring?**
- Is this about *progression/achievement* (players feel like they're improving)?
- *Leaderboard competition* (meaningful comparison between players)?
- *Difficulty adjustment* (harder games = bigger rewards)?
- *Session engagement* (keep them playing longer)?

**2. What's the win condition?**
Can you lose at solitaire, or is it always about *how well you won*? Is there a fixed target, or is it relative?

Here's what I know from competitive analysis: games that succeed with scoring either make it \`transparent and achievable\` (mobile casual) or \`skill-gated and aspirational\` (strategy). The worst ones try to do both and confuse everyone.

See the [Klondike scoring variants breakdown](https://en.wikipedia.org/wiki/Klondike_(solitaire)) and check \`docs/scoring-research.md\` for our prior notes.` },

  { kind: 'agent', speaker: 'john', turn: 1, content: `Before we debate scoring systems, I need to understand **what problem we're actually solving**. Let me ask the foundational questions:

> Who is this scoring system *for*, and what decision does it help them make?

A few candidate framings:
1. **Retention lever** — score drives "one more game" behavior
2. **Skill signal** — helps players self-assess and improve
3. **Social currency** — shareable, bragging rights

These aren't mutually exclusive, but they lead to *very* different designs. A retention score wants variance and near-misses. A skill score wants consistency and low noise.

**My implicit prior:** start with the simplest thing that ships. We can always layer complexity.` },

  { kind: 'agent', speaker: 'sally', turn: 1, content: `Before we debate scoring mechanics, I need to understand **who we're designing for**. Let me paint two very different scenarios:

**Scenario 1: The Casual Player** — Sarah opens the game on her phone during a coffee break. She plays a few rounds, half-paying attention. Does she care that her score is 4,237 points? Not really. She cares: *Did I win?* The scoring system should be almost invisible — a simple win/loss tracker, or a difficulty modifier ("I beat hard mode!").

**Scenario 2: The Competitive Player** — James has been playing solitaire variants for years. He keeps spreadsheets. He wants *progression, mastery, replayability with stakes.* For him, scoring **is** the game — the feedback loop that says "you're getting better."

The scoring isn't just math — it's the game telling players whether they're succeeding. Get that story wrong, and nothing else matters.

~~I'll suggest specific UX patterns once we align~~ — actually, let me preview one idea: a dual-layer display (big "YOU WON" + small score below).` },

  { kind: 'agent', speaker: 'winston', turn: 1, content: `Before I weigh in on scoring approaches, I need to understand **the constraints that actually matter**:

### Key questions

- **Is this scoring purely local** (calculated client-side, displayed immediately) **or authoritative** (validated server-side for leaderboards, anti-cheat)?
- **What's the business model?** Monetizing around score progression? Competitions? Or is this engagement sugar?
- **Scope of rules:** simple "points per card cleared" arithmetic, or complex conditional logic (bonuses, streaks, multipliers)?

### My implicit answer: start local-only

Most solitaire players just want feedback that feels good. Once you have real data on what players actually care about, you can layer server-side authority.

Here's a starter sketch:

\`\`\`typescript
interface ScoreEvent {
  kind: 'foundation' | 'tableau' | 'undo' | 'time-bonus';
  value: number;
  timestamp: number;
}

function computeScore(events: ScoreEvent[]): Score {
  // pure, deterministic, testable
  return events.reduce(
    (acc, e) => acc + e.value * modifier(e.kind),
    0,
  );
}
\`\`\`

The pure-function approach means we can replay any game to verify scores, which kills an entire class of bugs.` },
];

Object.assign(window, { AGENTS, agent, initials, PROJECTS, DEMO_MESSAGES });
