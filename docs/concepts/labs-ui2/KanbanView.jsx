/* global React, KANBAN_COLS, STORY_STATUS, ALL_STORIES, fmtSec, fmtCost, fmtTokens */
const { useState: useStateK, useMemo: useMemoK } = React;

function KanbanCard({ story, onSelect }) {
  const meta = STORY_STATUS[story.status];
  const prog = story.status === "done" ? 100 : (story.progress || 0);
  const isActive = ["running", "in_review", "fixing"].includes(story.status);

  return (
    <div
      onClick={() => onSelect(story)}
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${meta.color}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        cursor: "pointer",
        transition: "border-color 150ms, transform 150ms",
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-2)"; e.currentTarget.style.borderLeftColor = meta.color; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.borderLeftColor = meta.color; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 9, color: meta.color, fontWeight: 700 }}>{story.id}</span>
        <span className="mono" style={{ fontSize: 8, color: "var(--text-faint)", padding: "1px 5px", borderRadius: 3, background: "var(--surface)", border: "1px solid var(--border)" }}>
          {story.epicId}
        </span>
        <span className="mono" style={{ fontSize: 8, color: "var(--purple)", padding: "1px 5px", borderRadius: 3, background: "#8b5cf615", border: "1px solid #8b5cf625" }}>
          W{story.wave}
        </span>
        {isActive && <span className="dot dot-pulse" style={{ background: meta.color, width: 6, height: 6, marginLeft: "auto" }}/>}
      </div>

      <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500, lineHeight: 1.35, marginBottom: 8, textWrap: "pretty" }}>
        {story.label}
      </div>

      {isActive && (
        <div style={{ height: 3, background: "var(--border)", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
          <div style={{
            width: `${prog}%`, height: "100%",
            background: `linear-gradient(90deg, ${meta.color}88, ${meta.color})`,
            boxShadow: `0 0 6px ${meta.color}66`,
            transition: "width 300ms",
          }}/>
        </div>
      )}

      <div className="mono" style={{ fontSize: 9, color: "var(--text-mute)", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{story.sp}SP</span>
        <span style={{ color: "var(--text-faint)" }}>·</span>
        <span>{story.status === "done" ? fmtSec(story.actualSec) : fmtSec(story.plannedSec)}</span>
        {story.cost > 0 && <>
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <span style={{ color: "var(--amber)" }}>{fmtCost(story.cost)}</span>
        </>}
        {story.tokens > 0 && <>
          <span style={{ color: "var(--text-faint)", marginLeft: "auto" }}></span>
          <span style={{ color: "var(--cyan)", marginLeft: "auto" }}>{fmtTokens(story.tokens)}</span>
        </>}
      </div>
    </div>
  );
}

function KanbanView() {
  const [selected, setSelected] = useStateK(null);
  const [filter, setFilter] = useStateK("all");

  const columns = useMemoK(() => KANBAN_COLS.map(c => ({
    ...c,
    stories: ALL_STORIES.filter(s => c.matches.includes(s.status) && (filter === "all" || s.epicId === filter)),
  })), [filter]);

  const totalCost = columns.reduce((a, c) => a + c.stories.reduce((b, s) => b + (s.cost || 0), 0), 0);

  return (
    <div>
      {/* Filters */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", marginRight: 4 }}>Filter</span>
        {[{ id: "all", label: "All epics" }, ...window.PLAN.epics.map(e => ({ id: e.id, label: `${e.id} — ${e.label}` }))].map(o => (
          <button
            key={o.id}
            onClick={() => setFilter(o.id)}
            style={{
              padding: "5px 10px", borderRadius: 5, fontSize: 11,
              background: filter === o.id ? "var(--green-soft)" : "var(--surface)",
              border: `1px solid ${filter === o.id ? "var(--green)" : "var(--border)"}`,
              color: filter === o.id ? "var(--green)" : "var(--text-dim)",
              fontWeight: filter === o.id ? 600 : 400,
            }}
          >{o.label}</button>
        ))}
        <span style={{ marginLeft: "auto", color: "var(--text-mute)", fontSize: 11 }} className="mono">
          Total this view: <span style={{ color: "var(--amber)" }}>{fmtCost(totalCost)}</span>
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        {columns.map(col => {
          const colMeta = STORY_STATUS[col.id] || { color: "var(--text-mute)" };
          return (
            <div key={col.id} style={{
              background: "#0b1120",
              border: "1px solid var(--border)",
              borderRadius: 10,
              display: "flex", flexDirection: "column",
              minHeight: 520,
            }}>
              <div style={{
                padding: "12px 14px",
                borderBottom: "1px solid var(--border)",
                display: "flex", alignItems: "center", gap: 8,
                borderTop: `3px solid ${colMeta.color}`,
                borderRadius: "10px 10px 0 0",
              }}>
                <span className="dot" style={{ background: colMeta.color }}/>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{col.label}</span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-mute)", padding: "2px 6px", borderRadius: 3, background: "var(--surface)", border: "1px solid var(--border)" }}>
                  {col.stories.length}
                </span>
              </div>

              <div style={{ padding: 10, flex: 1, overflow: "auto" }}>
                {col.stories.length === 0 ? (
                  <div style={{ textAlign: "center", color: "var(--text-faint)", fontSize: 11, padding: "24px 12px" }} className="mono">
                    — empty —
                  </div>
                ) : col.stories.map(s => (
                  <KanbanCard key={s.id} story={s} onSelect={setSelected}/>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div
          onClick={() => setSelected(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", animation: "slideDown 180ms" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 520, maxHeight: "80vh", overflow: "auto",
              background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span className="mono" style={{ fontSize: 14, color: STORY_STATUS[selected.status].color, fontWeight: 700 }}>{selected.id}</span>
              <span style={{ fontSize: 17, fontWeight: 600, color: "var(--text)" }}>{selected.label}</span>
              <button onClick={() => setSelected(null)} style={{ marginLeft: "auto", color: "var(--text-mute)", fontSize: 18 }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 14 }}>{selected.desc}</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                { l: "Status", v: STORY_STATUS[selected.status].label, c: STORY_STATUS[selected.status].color },
                { l: "Epic / Wave", v: `${selected.epicId} / W${selected.wave}`, c: "var(--purple)" },
                { l: "Story points", v: `${selected.sp} SP`, c: "var(--text)" },
                { l: "Planned", v: fmtSec(selected.plannedSec), c: "var(--text-dim)" },
                { l: "Actual", v: selected.actualSec ? fmtSec(selected.actualSec) : "—", c: "var(--text-dim)" },
                { l: "Cost", v: fmtCost(selected.cost), c: "var(--amber)" },
              ].map(m => (
                <div key={m.l} style={{ padding: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
                  <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>{m.l}</div>
                  <div className="mono" style={{ fontSize: 13, color: m.c, fontWeight: 600 }}>{m.v}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ fontSize: 12, padding: "7px 14px", borderRadius: 5, background: "var(--green-soft)", border: "1px solid var(--green)", color: "var(--green)", fontWeight: 600 }}>View full story</button>
              <button style={{ fontSize: 12, padding: "7px 14px", borderRadius: 5, background: "var(--surface)", border: "1px solid var(--border-2)", color: "var(--text)" }}>Retry</button>
              <button style={{ fontSize: 12, padding: "7px 14px", borderRadius: 5, background: "var(--surface)", border: "1px solid var(--border-2)", color: "var(--text)" }}>View logs</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

window.KanbanView = KanbanView;
