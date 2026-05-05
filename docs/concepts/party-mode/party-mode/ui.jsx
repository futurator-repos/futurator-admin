/* global React, PROJECTS, AGENTS, agent, initials, RichText */
// Shared UI primitives for Party Mode.

const { useState, useEffect, useRef, useMemo } = React;

// ─────────────────────────────────────────────────────────
// ProjectSwitcher — segmented pill that opens a rich project palette
// ─────────────────────────────────────────────────────────
function ProjectSwitcher({ project, onSelect, variant = 'pill' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const filtered = PROJECTS.filter((p) =>
    p.id.toLowerCase().includes(query.toLowerCase()) ||
    p.path.toLowerCase().includes(query.toLowerCase()),
  );

  const statusChip = {
    HEALTHY: { label: 'Healthy', cls: 'chip-healthy' },
    DRIFTED: { label: 'Drifted', cls: 'chip-warn' },
    INSTALLING: { label: 'Installing…', cls: 'chip-warn' },
    FAILED: { label: 'Failed', cls: 'chip-err' },
    MISSING: { label: 'Missing', cls: '' },
  };

  const sc = statusChip[project.status] || statusChip.MISSING;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 10px 7px 12px',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--card)',
          color: 'var(--fg)',
          cursor: 'pointer',
          fontFamily: 'var(--sans)',
          fontSize: 13,
          transition: 'all 0.12s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-strong)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
      >
        <span className={`dot dot-${project.status === 'HEALTHY' ? 'ok' : project.status === 'DRIFTED' || project.status === 'INSTALLING' ? 'warn' : 'err'}`} />
        <span style={{ fontWeight: 600 }}>{project.id}</span>
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {project.path.replace('/home/ubuntu/', '~/')}
        </span>
        <span className={`chip ${sc.cls}`}>{sc.label}</span>
        {project.bmadVersion && (
          <span className="chip" style={{ fontFamily: 'var(--mono)' }}>
            bmad {project.bmadVersion}
          </span>
        )}
        {project.agents != null && (
          <span className="chip" style={{ fontFamily: 'var(--mono)' }}>
            {project.agents}/{project.totalAgents} agents
          </span>
        )}
        <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>· {project.inspectedAgo}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginLeft: 2, opacity: 0.6 }}>
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          width: 560,
          maxHeight: 460,
          background: '#0f0f0f',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02)',
          zIndex: 50,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6 }}>
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--fg)', fontSize: 13, fontFamily: 'var(--sans)',
              }}
            />
            <span className="kbd">Esc</span>
          </div>
          <div className="scroll-thin" style={{ overflowY: 'auto', padding: 6 }}>
            {filtered.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
                No matches. Create a folder in <code className="inline-code">~/projects/</code> and re-inspect.
              </div>
            )}
            {filtered.map((p) => (
              <ProjectRow key={p.id} project={p} active={p.id === project.id} onClick={() => { onSelect(p); setOpen(false); }} />
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: '6px 10px', display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--fg-dim)' }}>
            <span><span className="kbd">↑↓</span> navigate &nbsp; <span className="kbd">↵</span> select</span>
            <span>{PROJECTS.length} projects · <span style={{ color: 'var(--accent)' }}>{PROJECTS.filter((p) => p.status === 'HEALTHY').length} healthy</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectRow({ project, active, onClick }) {
  const sc = {
    HEALTHY: { label: 'Healthy', cls: 'chip-healthy' },
    DRIFTED: { label: 'Drifted', cls: 'chip-warn' },
    INSTALLING: { label: 'Installing…', cls: 'chip-warn' },
    FAILED: { label: 'Failed', cls: 'chip-err' },
    MISSING: { label: 'Missing', cls: '' },
  }[project.status];
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        width: '100%',
        padding: '10px 10px',
        border: 'none',
        background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
        color: 'var(--fg)',
        cursor: 'pointer',
        borderRadius: 8,
        textAlign: 'left',
        fontFamily: 'var(--sans)',
        alignItems: 'center',
        gap: 12,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <span className={`dot dot-${project.status === 'HEALTHY' ? 'ok' : project.status === 'FAILED' || project.status === 'MISSING' ? 'err' : 'warn'}`} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{project.id}</span>
          <span className={`chip ${sc.cls}`} style={{ fontSize: 10 }}>{sc.label}</span>
          {project.sessions > 0 && (
            <span style={{ fontSize: 10.5, color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>
              {project.sessions} {project.sessions === 1 ? 'session' : 'sessions'}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'var(--mono)', marginTop: 2, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {project.path}
        </div>
      </div>
      <div style={{ textAlign: 'right', fontSize: 10.5, color: 'var(--fg-dim)', fontFamily: 'var(--mono)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {project.bmadVersion && <span>bmad {project.bmadVersion}</span>}
        {project.agents != null && <span>{project.agents}/{project.totalAgents} agents · {(project.sizeKb / 1024).toFixed(1)} MB</span>}
        {project.lastActivity !== '—' && <span>last active {project.lastActivity}</span>}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// Avatar
// ─────────────────────────────────────────────────────────
function Avatar({ speaker, size = 32, active = false, showIcon = true }) {
  const a = agent(speaker);
  return (
    <div
      className={active ? 'avatar-active' : ''}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: a.bg,
        color: a.accent,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.5,
        fontWeight: 600,
        border: `1px solid ${a.accent}33`,
        flexShrink: 0,
        fontFamily: 'var(--sans)',
      }}
      title={`${a.name} — ${a.role}`}
    >
      {showIcon && a.icon ? <span style={{ fontSize: size * 0.52 }}>{a.icon}</span> : initials(a.name)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// TurnDivider
// ─────────────────────────────────────────────────────────
function TurnDivider({ turn, agents = [] }) {
  return (
    <div className="turn-divider">
      <span className="turn-divider-line" />
      <span className="turn-divider-label">Turn {String(turn).padStart(2, '0')}</span>
      {agents.length > 0 && (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--sans)', textTransform: 'none', letterSpacing: 0 }}>
          {agents.length} speakers: {agents.map((a) => agent(a).name).join(', ')}
        </span>
      )}
      <span className="turn-divider-line" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Processing indicator — shown while the terminal is working
// ─────────────────────────────────────────────────────────
function ProcessingIndicator({ stage, activeAgent, statusLines }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'linear-gradient(180deg, rgba(74,222,128,0.04) 0%, transparent 100%)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', width: 22, height: 22 }}>
          <svg width="22" height="22" viewBox="0 0 22 22">
            <circle cx="11" cy="11" r="9" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
            <circle cx="11" cy="11" r="9" fill="none" stroke="var(--accent)" strokeWidth="2"
              strokeDasharray="14 42" strokeLinecap="round" transform="rotate(-90 11 11)">
              <animateTransform attributeName="transform" type="rotate" from="-90 11 11" to="270 11 11" dur="1.2s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>
        <div style={{ flex: 1, fontSize: 13, fontFamily: 'var(--mono)' }}>
          <span style={{ color: 'var(--accent)' }}>●</span>{' '}
          <span className="soft-pulse">{stage || 'Party agents are thinking…'}</span>
        </div>
        {activeAgent && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
            <Avatar speaker={activeAgent} size={20} />
            <span><strong style={{ color: agent(activeAgent).accent }}>{agent(activeAgent).name}</strong> is preparing…</span>
          </div>
        )}
      </div>

      {statusLines && statusLines.length > 0 && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--fg-muted)',
          display: 'flex', flexDirection: 'column', gap: 3,
          paddingLeft: 2,
        }}>
          {statusLines.map((line, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                color: line.state === 'done' ? 'var(--accent)' : line.state === 'running' ? 'var(--warn)' : 'var(--fg-dim)',
                width: 10, display: 'inline-block',
              }}>
                {line.state === 'done' ? '✓' : line.state === 'running' ? '›' : '·'}
              </span>
              <span style={{
                color: line.state === 'done' ? 'var(--fg-muted)' : 'var(--fg)',
                opacity: line.state === 'pending' ? 0.5 : 1,
              }}>
                {line.text}
              </span>
              {line.state === 'running' && (
                <span style={{ marginLeft: 4 }}>
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Composer — textarea + send/stop + attachments + mentions
// ─────────────────────────────────────────────────────────
function Composer({ value, onChange, onSend, onStop, isProcessing, placeholder, canMention = true }) {
  const maxBytes = 8192;
  const bytes = new TextEncoder().encode(value || '').length;
  const pct = Math.min(100, (bytes / maxBytes) * 100);
  const near = pct > 80;
  const textareaRef = useRef(null);

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 14,
      background: 'var(--bg-raised)',
      padding: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <textarea
        ref={textareaRef}
        className="composer-input"
        style={{ border: 'none', padding: '4px 6px', background: 'transparent', minHeight: 60, maxHeight: 180 }}
        placeholder={isProcessing ? 'Party agents are thinking… (type your next message)' : (placeholder || 'Type a message, @-mention an agent to target them')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        rows={2}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button className="btn btn-ghost btn-icon tooltip" data-tooltip="Attach file or code reference">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M10 4L5 9a2.5 2.5 0 003.5 3.5L13 8a4 4 0 10-5.5-5.5L3 7" />
          </svg>
        </button>
        {canMention && (
          <button className="btn btn-ghost btn-icon tooltip" data-tooltip="Mention agent">
            <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1, color: 'var(--fg-muted)' }}>@</span>
          </button>
        )}
        <button className="btn btn-ghost btn-icon tooltip" data-tooltip="Slash commands">
          <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--fg-muted)' }}>/</span>
        </button>

        <span style={{ flex: 1 }} />

        {/* byte counter as progress ring */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: near ? 'var(--warn)' : 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--border)" strokeWidth="1.5" />
            <circle cx="7" cy="7" r="5.5" fill="none"
              stroke={near ? 'var(--warn)' : 'var(--accent)'} strokeWidth="1.5"
              strokeDasharray={`${(pct / 100) * 34.5} 34.5`}
              strokeLinecap="round"
              transform="rotate(-90 7 7)" />
          </svg>
          <span>{bytes.toLocaleString()}/{maxBytes.toLocaleString()}</span>
        </div>

        <span style={{ color: 'var(--fg-dim)', fontSize: 10.5, marginLeft: 4 }}>
          <span className="kbd">⌘</span><span className="kbd">↵</span> to send
        </span>

        {isProcessing ? (
          <button className="btn" style={{ borderColor: 'var(--err)', color: 'var(--err)' }} onClick={onStop}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1.5" /></svg>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!value.trim()} onClick={onSend}>
            Send
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// RosterTable — compact version of the system "here's your roster"
// ─────────────────────────────────────────────────────────
function RosterTable({ agents }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', margin: '4px 0' }}>
      <table className="rich-table" style={{ margin: 0 }}>
        <thead>
          <tr>
            <th style={{ width: 32 }}></th>
            <th style={{ width: 110 }}>Name</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((key) => {
            const a = agent(key);
            return (
              <tr key={key}>
                <td style={{ textAlign: 'center' }}><span style={{ fontSize: 16 }}>{a.icon}</span></td>
                <td><strong style={{ color: a.accent }}>{a.name}</strong></td>
                <td style={{ color: 'var(--fg-muted)' }}>{a.role}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

Object.assign(window, {
  ProjectSwitcher,
  Avatar,
  TurnDivider,
  ProcessingIndicator,
  Composer,
  RosterTable,
});
