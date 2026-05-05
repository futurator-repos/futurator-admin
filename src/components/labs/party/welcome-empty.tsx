'use client';
import { Scale, FileText, FlaskConical, Map } from 'lucide-react';
import { Avatar } from './avatar';
import { agentIdentity } from './agent-identity';

interface Props {
  rosterSize?: number;
  onPick?: (prompt: string) => void;
  disabled?: boolean;
}

const DEFAULT_ROSTER = ['Mary', 'John', 'Sally', 'Winston', 'Amelia', 'paige'];

const SUGGESTIONS: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string; prompt: string }[] = [
  {
    icon: Scale,
    title: 'Debate a scoring system',
    desc: 'Get PM, UX, and Architect perspectives on a scoring system for your game.',
    prompt: "Let's debate what scoring system this game should use and why.",
  },
  {
    icon: FileText,
    title: 'Review this PRD',
    desc: 'Have the team critique requirements before handoff to engineering.',
    prompt: 'Review our current PRD — what risks, gaps, or contradictions do you see?',
  },
  {
    icon: FlaskConical,
    title: 'Brainstorm test strategy',
    desc: 'Murat and Amelia will debate TDD vs integration-first.',
    prompt: "What's the right test strategy for this codebase — TDD, integration-first, or a mix?",
  },
  {
    icon: Map,
    title: 'Architecture walkthrough',
    desc: 'Winston will drive; others will poke holes.',
    prompt: 'Give me an architecture walkthrough of this project and poke holes in it.',
  },
];

export function WelcomeEmpty({ rosterSize, onPick, disabled = false }: Props) {
  return (
    <div className="flex-1 overflow-y-auto px-5 py-7">
      <div className="mx-auto max-w-[640px]">
        <div className="mb-1 text-[20px] font-semibold text-foreground">
          Welcome to <span className="text-success">Party Mode</span>
        </div>
        <div className="mb-5 text-[13px] text-muted-foreground">
          Start a debate with the BMAD agents. They&apos;ll respond together, taking turns,
          arguing their perspective.
        </div>

        <div className="mb-2 text-[11px] uppercase tracking-wider font-mono text-muted-foreground">
          Roster · {rosterSize ?? DEFAULT_ROSTER.length} agents available
        </div>
        <div className="mb-5 grid grid-cols-3 gap-1.5">
          {DEFAULT_ROSTER.map((name) => {
            const id = agentIdentity(name);
            return (
              <div
                key={name}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
              >
                <Avatar speaker={name} size={26} />
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold" style={{ color: id.accentHex }}>
                    {name}
                  </div>
                  <div className="truncate text-[10.5px] text-muted-foreground">
                    {id.title || '—'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mb-2 text-[11px] uppercase tracking-wider font-mono text-muted-foreground">
          Try starting with
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.title}
                type="button"
                onClick={() => onPick?.(s.prompt)}
                disabled={disabled}
                className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-muted-foreground/40 hover:bg-card/60 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon className="h-5 w-5 shrink-0 text-foreground/70 mt-0.5" />
                <div className="min-w-0">
                  <div className="mb-0.5 text-[13px] font-semibold">{s.title}</div>
                  <div className="text-[11.5px] leading-[1.45] text-muted-foreground">
                    {s.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
