/* global React, DEMO_MESSAGES, agent, AGENTS, Avatar, TurnDivider, ProcessingIndicator, Composer, RichText, RosterTable */
// Chat layout variations for Party Mode.

const { useState, useEffect, useRef, useMemo } = React;

// ─────────────────────────────────────────────────────────
// PartyMessageCard — Slack-style grouped message for an agent
// ─────────────────────────────────────────────────────────
function PartyMessageCard({ speaker, content, streaming, roster }) {
  const a = agent(speaker);
  return (
    <div style={{
      position: 'relative',
      padding: '8px 12px 10px 52px',
      borderRadius: 8,
      transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.015)'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{ position: 'absolute', left: 8, top: 8 }}>
        <Avatar speaker={speaker} size={34} />
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: a.accent }}>{a.name}</span>
        <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{a.role}</span>
        <span style={{ fontSize: 10.5, color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>· just now</span>
      </div>
      {roster
        ? <RosterTable agents={['mary', 'paige', 'john', 'sally', 'winston', 'amelia']} />
        : <RichText text={content} />
      }
      {streaming && <span className="stream-cursor" />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// SystemCard — BMad Master / system notes
// ─────────────────────────────────────────────────────────
function SystemCard({ content, roster }) {
  return (
    <div style={{
      margin: '2px 0 2px 52px',
      padding: '7px 12px',
      borderLeft: '2px solid var(--border-strong)',
      color: 'var(--fg-muted)',
      fontSize: 13,
      fontStyle: roster ? 'normal' : 'normal',
    }}>
      {roster
        ? <>
            <div style={{ marginBottom: 4 }}><RichText text={content} /></div>
            <RosterTable agents={['mary', 'paige', 'john', 'sally', 'winston', 'amelia']} />
          </>
        : <RichText text={content} />
      }
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// UserBubble — right-aligned mono bubble
// ─────────────────────────────────────────────────────────
function UserBubble({ content }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '4px 0 8px' }}>
      <div style={{
        maxWidth: '70%',
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: '12px 12px 4px 12px',
        padding: '9px 13px',
        fontFamily: 'var(--mono)',
        fontSize: 12.5,
        color: 'var(--fg)',
        whiteSpace: 'pre-wrap',
      }}>
        {content}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Avatar Rail — sticky left column showing who's in the room
// ─────────────────────────────────────────────────────────
function AvatarRail({ activeAgents, currentSpeaker }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0',
      borderRight: '1px solid var(--border)',
      width: 56, alignItems: 'center',
    }}>
      <div style={{ fontSize: 9, color: 'var(--fg-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.08 }}>
        Room
      </div>
      {activeAgents.map((key) => {
        const a = agent(key);
        const active = currentSpeaker === key;
        return (
          <div key={key} style={{ position: 'relative' }} className="tooltip" data-tooltip={`${a.name} · ${a.role}`}>
            <Avatar speaker={key} size={34} active={active} />
            {active && (
              <span style={{
                position: 'absolute', bottom: -2, right: -2,
                width: 10, height: 10, borderRadius: 5,
                background: a.accent, border: '2px solid var(--bg)',
              }} />
            )}
          </div>
        );
      })}
      <div style={{ width: 24, height: 1, background: 'var(--border)' }} />
      <button className="btn btn-ghost btn-icon" style={{ color: 'var(--fg-dim)' }} title="Add agent">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 2v8M2 6h8" /></svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Session Header — inline (no "card" panel anymore)
// ─────────────────────────────────────────────────────────
function SessionHeader({ title, turn, sessionId, onClose }) {
  return (
    <div style={{
      padding: '10px 16px',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      background: 'var(--bg)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{title}</span>
          <span className="chip chip-healthy">live</span>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>
            turn {String(turn).padStart(2, '0')} · claude:{sessionId}
          </span>
        </div>
      </div>
      <button className="btn btn-ghost tooltip" data-tooltip="Export transcript">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M7 1v9M3.5 6.5L7 10l3.5-3.5M1 12h12" />
        </svg>
      </button>
      <button className="btn btn-ghost tooltip" data-tooltip="Session settings">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="2" />
          <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button className="btn" onClick={onClose}>Close</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Main chat screen — builds a full mock using the demo messages
// ─────────────────────────────────────────────────────────
function ChatScreen({ phase = 'streaming', layout = 'slack', width, height }) {
  // phase: 'empty' | 'sending' | 'processing' | 'streaming' | 'idle'
  const project = { id: 'solitaire', path: '/home/ubuntu/projects/solitaire', status: 'HEALTHY', bmadVersion: '6.3.0', agents: 6, totalAgents: 6, inspectedAgo: '15h ago' };
  const [draft, setDraft] = useState(phase === 'sending' ? 'What about time-based bonuses for fast completion?' : '');

  const activeAgents = ['master', 'mary', 'john', 'sally', 'winston'];

  // Build messages slice based on phase
  let visibleMessages = DEMO_MESSAGES;
  let streamingSpeaker = null;
  if (phase === 'empty') {
    visibleMessages = [];
  } else if (phase === 'sending' || phase === 'processing') {
    visibleMessages = DEMO_MESSAGES.slice(0, 1); // only user message
  } else if (phase === 'streaming') {
    // Show up through Sally, with Winston streaming
    visibleMessages = DEMO_MESSAGES.slice(0, -1);
    streamingSpeaker = 'winston';
  }

  const processingLines = phase === 'processing' ? [
    { text: 'Analyzing topic & project context', state: 'done' },
    { text: 'Selecting best-fit agents from BMAD roster', state: 'done' },
    { text: 'Spawning 4 agents · claude-sonnet-4-5', state: 'running' },
    { text: 'Streaming multi-agent response', state: 'pending' },
  ] : phase === 'streaming' ? [
    { text: 'Winston is composing a response', state: 'running' },
  ] : [];

  return (
    <div className="ab-root" style={{ width: '100%', height: '100%' }}>
      {/* Top bar — Labs + project switcher */}
      <TopBar project={project} />

      {/* Tabs */}
      <Tabs active="party" />

      {/* Session header */}
      {phase !== 'empty' && (
        <SessionHeader title="Scoring system debate" turn={phase === 'streaming' ? 1 : 0} sessionId="5a1e8bc2" onClose={() => {}} />
      )}

      {/* Chat body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {layout === 'slack' && phase !== 'empty' && (
          <AvatarRail activeAgents={activeAgents} currentSpeaker={streamingSpeaker} />
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <MessageList
            messages={visibleMessages}
            streamingSpeaker={streamingSpeaker}
            phase={phase}
            processingLines={processingLines}
          />

          {/* Composer */}
          <div style={{ padding: '10px 20px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => setDraft('')}
              onStop={() => {}}
              isProcessing={phase === 'processing' || phase === 'streaming' || phase === 'sending'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function TopBar({ project }) {
  return (
    <div style={{
      height: 48,
      borderBottom: '1px solid var(--border)',
      padding: '0 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      background: 'var(--bg)',
      flexShrink: 0,
    }}>
      <button className="btn btn-ghost btn-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M10 3L5 8l5 5" /></svg></button>
      <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.3 }}>Labs</div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--mono)' }}>
        <span className="dot dot-ok" /> Daemon
        <span className="chip" style={{ marginLeft: 4 }}>Local</span>
        <span className="chip chip-healthy">⚙ EC2</span>
        <span style={{ color: 'var(--accent)' }}>running</span>
        <span>2 active</span>
        <span style={{ color: 'var(--accent)' }}>✓ oauth</span>
        <button className="btn btn-ghost" style={{ padding: '3px 6px' }}>⟳ Re-auth</button>
      </div>
      <div style={{ width: 30, height: 30, borderRadius: 15, background: 'rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#c4b5fd' }}>RA</div>
    </div>
  );
}

function Tabs({ active }) {
  const project = { id: 'solitaire', path: '/home/ubuntu/projects/solitaire', status: 'HEALTHY', bmadVersion: '6.3.0', agents: 6, totalAgents: 6, inspectedAgo: '15h ago' };
  const tabs = [
    { id: 'agentic', label: 'Agentic Workflow' },
    { id: 'claude', label: 'Claude Code Pipeline' },
    { id: 'party', label: 'Party' },
  ];
  return (
    <div style={{
      padding: '10px 20px 0',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      background: 'var(--bg)',
      flexShrink: 0,
    }}>
      <ProjectSwitcher project={project} onSelect={() => {}} />
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 2 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            style={{
              padding: '8px 12px',
              border: 'none',
              borderBottom: active === t.id ? '2px solid var(--fg)' : '2px solid transparent',
              background: 'transparent',
              color: active === t.id ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: active === t.id ? 600 : 500,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'var(--sans)',
            }}
          >{t.label}</button>
        ))}
      </div>
    </div>
  );
}

function MessageList({ messages, streamingSpeaker, phase, processingLines }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length]);

  if (phase === 'empty') {
    return <EmptyState />;
  }

  return (
    <div ref={ref} className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 4px' }}>
      {messages.map((m, i) => {
        const prevTurn = i > 0 ? messages[i - 1].turn : null;
        const showDivider = m.turn && m.turn !== prevTurn && m.kind === 'user';
        return (
          <React.Fragment key={i}>
            {showDivider && m.turn > 0 && (
              <TurnDivider turn={m.turn} agents={['mary', 'john', 'sally', 'winston']} />
            )}
            {m.kind === 'user' && <UserBubble content={m.content} />}
            {m.kind === 'system' && <SystemCard content={m.content} roster={m.roster} />}
            {m.kind === 'agent' && <PartyMessageCard speaker={m.speaker} content={m.content} />}
          </React.Fragment>
        );
      })}

      {/* streaming message */}
      {streamingSpeaker && (
        <PartyMessageCard
          speaker={streamingSpeaker}
          content={`Before I weigh in on scoring approaches, I need to understand **the constraints that actually matter**:

### Key questions

- **Is this scoring purely local** (calculated client-side, displayed immediately) **or authoritative**`}
          streaming
        />
      )}

      {/* processing indicator */}
      {(phase === 'processing' || phase === 'sending') && (
        <div style={{ marginTop: 10 }}>
          <ProcessingIndicator
            stage={phase === 'sending' ? 'Sending message…' : 'BMad Master is routing your message'}
            statusLines={processingLines}
          />
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const suggestions = [
    { icon: '⚖️', title: 'Debate a scoring system', desc: 'Get PM, UX, and Architect perspectives on a scoring system for your game.' },
    { icon: '📐', title: 'Review this PRD', desc: 'Have the team critique requirements before handoff to engineering.' },
    { icon: '🧪', title: 'Brainstorm test strategy', desc: 'Murat and Amelia will debate TDD vs integration-first.' },
    { icon: '🗺️', title: 'Architecture walkthrough', desc: 'Winston will drive; others will poke holes.' },
  ];
  return (
    <div style={{ flex: 1, padding: '28px 20px', overflowY: 'auto' }} className="scroll-thin">
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4, color: 'var(--fg)' }}>
          Welcome to <span style={{ color: 'var(--accent)' }}>Party Mode</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 20 }}>
          Start a debate with the BMAD agents. They'll respond together, taking turns, arguing their perspective.
        </div>

        <div style={{ fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 8 }}>
          Roster · 6 agents available
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 20 }}>
          {['mary', 'john', 'sally', 'winston', 'amelia', 'paige'].map((k) => {
            const a = agent(k);
            return (
              <div key={k} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--card)',
              }}>
                <Avatar speaker={k} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: a.accent }}>{a.name}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.role}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 8 }}>
          Try starting with
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {suggestions.map((s) => (
            <button key={s.title} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--card)',
              color: 'var(--fg)',
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'var(--sans)',
              transition: 'all 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.background = 'var(--card-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--card)'; }}
            >
              <span style={{ fontSize: 18 }}>{s.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.45 }}>{s.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatScreen, PartyMessageCard, SystemCard, UserBubble, AvatarRail });
