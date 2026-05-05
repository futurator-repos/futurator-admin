/* global React, STATUS_META, PROJECTS, fmtCost */
const { useState: useStateSel, useRef: useRefSel, useEffect: useEffectSel, useMemo: useMemoSel } = React;

function ProjectSelector({ current, onChange }) {
  const [open, setOpen] = useStateSel(false);
  const [q, setQ] = useStateSel("");
  const [focusIdx, setFocusIdx] = useStateSel(0);
  const [hoverIntent, setHoverIntent] = useStateSel(null); // projectId whose intent is hovered
  const wrapRef = useRefSel(null);
  const inputRef = useRefSel(null);

  useEffectSel(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffectSel(() => {
    if (open && inputRef.current) setTimeout(() => inputRef.current?.focus(), 20);
    if (!open) { setQ(""); setHoverIntent(null); }
  }, [open]);

  const filtered = useMemoSel(() => {
    const needle = q.toLowerCase().trim();
    if (!needle) return PROJECTS;
    return PROJECTS.filter(p =>
      p.name.toLowerCase().includes(needle) ||
      p.intent.toLowerCase().includes(needle) ||
      p.status.toLowerCase().includes(needle)
    );
  }, [q]);

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx(i => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { onChange(filtered[focusIdx]); setOpen(false); }
    else if (e.key === "Escape") setOpen(false);
  };

  const currentMeta = STATUS_META[current.status];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "7px 12px", borderRadius: 2,
          background: "transparent",
          border: `1px solid ${open ? "var(--border-2)" : "var(--border)"}`,
          minWidth: 240, textAlign: "left",
          transition: "border-color 140ms",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = "var(--border-2)"}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = "var(--border)"; }}
      >
        <span className="dot" style={{ background: currentMeta.dot, width: 6, height: 6, flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: "var(--text)", letterSpacing: "0.01em", fontWeight: 400 }}>{current.name}</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-mute)", textTransform: "uppercase", letterSpacing: "0.14em", marginLeft: 4 }}>
          {currentMeta.label}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 8, color: "var(--text-faint)", transition: "transform 150ms", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, width: 460, zIndex: 100,
          background: "var(--bg-elev)", border: "1px solid var(--border-2)", borderRadius: 2,
          boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.02)",
          animation: "slideDown 140ms ease",
          overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: "var(--text-mute)" }}>
              <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={e => { setQ(e.target.value); setFocusIdx(0); }}
              onKeyDown={onKey}
              placeholder="Search plans…"
              style={{ flex: 1, fontSize: 13, color: "var(--text)", letterSpacing: "0.01em" }}
            />
            <kbd className="mono" style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.1em" }}>
              {filtered.length}
            </kbd>
          </div>

          <div style={{ maxHeight: 440, overflow: "auto" }}>
            {filtered.length === 0 && (
              <div style={{ padding: 36, textAlign: "center", color: "var(--text-mute)", fontSize: 12 }}>
                No plans match <span className="mono" style={{ color: "var(--text)" }}>{q}</span>
              </div>
            )}
            {filtered.map((p, i) => {
              const meta = STATUS_META[p.status];
              const active = i === focusIdx;
              const isCur = p.id === current.id;
              const pct = p.totalStories ? Math.round((p.doneStories / p.totalStories) * 100) : 0;
              const showTip = hoverIntent === p.id;
              return (
                <div
                  key={p.id}
                  onMouseEnter={() => { setFocusIdx(i); setHoverIntent(p.id); }}
                  onMouseLeave={() => setHoverIntent(null)}
                  onClick={() => { onChange(p); setOpen(false); }}
                  style={{
                    position: "relative",
                    padding: "14px 18px",
                    borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none",
                    background: active ? "var(--surface)" : "transparent",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 14,
                    transition: "background 120ms",
                  }}
                >
                  <span className="dot" style={{ background: meta.dot, flexShrink: 0, width: 6, height: 6 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                      <span style={{ fontSize: 14, color: "var(--text)", letterSpacing: "0.005em" }}>{p.name}</span>
                      <span className="mono" style={{ fontSize: 8, color: meta.color, textTransform: "uppercase", letterSpacing: "0.18em" }}>
                        {meta.label}
                      </span>
                      {isCur && <span className="mono" style={{ fontSize: 8, color: "var(--text-dim)", marginLeft: "auto", letterSpacing: "0.18em", textTransform: "uppercase" }}>current</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }} className="mono">
                      <span style={{ color: "var(--text-mute)" }}>{p.doneStories}/{p.totalStories}</span>
                      <span style={{ color: "var(--text-faint)" }}>·</span>
                      <span style={{ color: "var(--text-mute)" }}>{fmtCost(p.cost)}</span>
                      <span style={{ color: "var(--text-faint)" }}>·</span>
                      <span style={{ color: "var(--text-mute)" }}>{p.sizeMb}MB</span>
                      <span style={{ color: "var(--text-faint)" }}>·</span>
                      <span style={{ color: "var(--text-mute)" }}>{p.lastUpdate}</span>
                    </div>
                    {/* inline progress bar — very thin */}
                    <div style={{ marginTop: 8, height: 1, background: "var(--border)", overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: meta.color, transition: "width 200ms", opacity: 0.7 }}/>
                    </div>
                  </div>

                  {/* Intent tooltip */}
                  {showTip && (
                    <div style={{
                      position: "absolute", top: "50%", left: "calc(100% + 10px)", transform: "translateY(-50%)",
                      width: 300, padding: "12px 14px", zIndex: 200,
                      background: "var(--bg)", border: "1px solid var(--border-2)", borderRadius: 2,
                      boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
                      animation: "slideDown 120ms ease",
                    }}>
                      <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.22em", marginBottom: 6 }}>Intent</div>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.55 }}>{p.intent}</div>
                      <div className="mono" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.1em" }}>
                        {p.path}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.14em", textTransform: "uppercase" }} className="mono">
            <span><kbd style={{ color: "var(--text-mute)" }}>↑↓</kbd> nav</span>
            <span><kbd style={{ color: "var(--text-mute)" }}>↵</kbd> open</span>
            <span><kbd style={{ color: "var(--text-mute)" }}>esc</kbd> close</span>
            <span style={{ marginLeft: "auto", color: "var(--text-dim)", cursor: "pointer" }}>＋ New Plan</span>
          </div>
        </div>
      )}
    </div>
  );
}

window.ProjectSelector = ProjectSelector;
