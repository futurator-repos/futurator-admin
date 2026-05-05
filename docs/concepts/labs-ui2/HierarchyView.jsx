/* global React, STORY_STATUS, fmtSec, fmtCost, fmtTokens, aggregateWave, aggregateEpic, aggregatePlan, PLAN */
const { useState: useStateH, useRef: useRefH, useEffect: useEffectH } = React;

function StatusPill({ status, size = "sm" }) {
  const meta = STORY_STATUS[status] || { label: status, color: "#6b6f78" };
  const pulse = ["running", "in_review", "fixing", "queued"].includes(status);
  return (
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 9,
      color: meta.color,
      textTransform: "uppercase", letterSpacing: "0.2em",
      fontWeight: 400,
    }}>
      <span className={pulse ? "dot dot-pulse" : "dot"} style={{ background: meta.color, width: 5, height: 5 }}/>
      {meta.label}
    </span>
  );
}

function MetricChip({ label, value, color = "var(--text)" }) {
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.1 }}>
      <span className="mono" style={{ fontSize: 7, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.22em" }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, color, fontWeight: 400, marginTop: 3, letterSpacing: "0.02em" }}>{value}</span>
    </div>
  );
}

function LogEntry({ log }) {
  const colorMap = {
    step_start: "#a78bfa",
    step_complete: "#22c55e",
    step_failed: "#ef4444",
    step_retried: "#f59e0b",
    tool_use: "#22d3ee",
    agent_message: "#e6edf7",
    step_progress: "#94a3b8",
    job_complete: "#22c55e",
    validation_failed: "#ef4444",
  };
  const color = colorMap[log.type] || "#94a3b8";
  return (
    <div style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: 11, fontFamily: "var(--font-mono)", alignItems: "flex-start" }}>
      <span style={{ color: "var(--text-faint)", flexShrink: 0, width: 44 }}>{log.t}</span>
      <span style={{ color, flexShrink: 0, width: 100, textTransform: "uppercase", fontSize: 9, fontWeight: 600, letterSpacing: "0.05em", paddingTop: 1 }}>
        {log.type.replace("_", " ")}
      </span>
      <span style={{ color: "var(--text-faint)", flexShrink: 0, width: 56, fontSize: 9, paddingTop: 1 }}>{log.step}</span>
      <span style={{ color: "var(--text-dim)", flex: 1, lineHeight: 1.5 }}>{log.msg}</span>
    </div>
  );
}

function StoryRow({ story, expanded, onToggle }) {
  const meta = STORY_STATUS[story.status];
  const prog = story.status === "done" ? 100 : (story.progress || 0);
  const isActive = ["running", "in_review", "fixing"].includes(story.status);

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "24px 60px 1fr auto auto auto auto auto",
          alignItems: "center", gap: 14,
          padding: "12px 18px 12px 54px",
          cursor: "pointer",
          transition: "background 120ms",
          background: expanded ? "rgba(255,255,255,0.025)" : "transparent",
        }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = "rgba(255,255,255,0.015)"; }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{ fontSize: 9, color: "var(--text-faint)", transition: "transform 160ms", transform: expanded ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{story.id}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 400, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.005em" }}>
            {story.label}
          </div>
          <div className="mono" style={{ fontSize: 9, color: "var(--text-mute)", display: "flex", gap: 10, alignItems: "center", textTransform: "uppercase", letterSpacing: "0.14em" }}>
            <span>{story.sp} SP</span>
            {story.agent && <><span style={{ color: "var(--text-faint)" }}>·</span><span>{story.agent}</span></>}
            {story.touchPoints && story.touchPoints.length > 0 && (
              <><span style={{ color: "var(--text-faint)" }}>·</span><span>{story.touchPoints.length} files</span></>
            )}
          </div>
        </div>

        {/* progress bar cell */}
        <div style={{ width: 120, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: "var(--border)", overflow: "hidden" }}>
            <div style={{
              width: `${prog}%`, height: "100%",
              background: meta.color,
              transition: "width 300ms",
              opacity: isActive ? 1 : 0.7,
            }}/>
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-mute)", minWidth: 28, textAlign: "right" }}>{Math.round(prog)}%</span>
        </div>

        <MetricChip label="time" value={story.status === "done" ? fmtSec(story.actualSec) : isActive ? fmtSec((story.plannedSec || 0) * (prog / 100)) + "…" : fmtSec(story.plannedSec)} color="var(--text-dim)" />
        <MetricChip label="tokens" value={fmtTokens(story.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(story.cost)} color="var(--amber)" />
        <StatusPill status={story.status} />
      </div>

      {expanded && (
        <div style={{ background: "rgba(255,255,255,0.015)", padding: "20px 54px 24px", borderTop: "1px solid var(--border)", animation: "slideDown 180ms ease" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 28 }}>
            {/* Left: description + criteria + files */}
            <div>
              <div style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.24em", marginBottom: 10 }} className="mono">Description</div>
              <p style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.65, marginBottom: 20, textWrap: "pretty" }}>{story.desc}</p>

              {story.criteria && story.criteria.length > 0 && (
                <>
                  <div style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.24em", marginBottom: 10 }} className="mono">Acceptance criteria</div>
                  <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 5 }}>
                    {story.criteria.map((c, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{
                          width: 14, height: 14, borderRadius: 3,
                          border: `1px solid ${c.done ? "var(--green)" : "var(--border-2)"}`,
                          background: c.done ? "var(--green-soft)" : "transparent",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          color: "var(--green)", fontSize: 10, flexShrink: 0,
                        }}>{c.done ? "✓" : ""}</span>
                        <span style={{ color: c.done ? "var(--text-dim)" : "var(--text)", textDecoration: c.done ? "line-through" : "none", textDecorationColor: "var(--text-faint)" }}>
                          {c.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {story.touchPoints && story.touchPoints.length > 0 && (
                <>
                  <div style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.24em", marginBottom: 10 }} className="mono">Touch points</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {story.touchPoints.map(p => (
                      <span key={p} className="mono" style={{ fontSize: 10, padding: "3px 8px", border: "1px solid var(--border)", color: "var(--text-dim)", letterSpacing: "0.02em" }}>{p}</span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Right: live log */}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.24em" }} className="mono">Live log</div>
                {isActive && <span className="mono" style={{ fontSize: 9, color: "var(--purple)", display: "inline-flex", alignItems: "center", gap: 6, textTransform: "uppercase", letterSpacing: "0.22em" }}>
                  <span className="dot dot-pulse" style={{ background: "var(--purple)", width: 5, height: 5 }}/> streaming
                </span>}
              </div>
              <div style={{
                background: "var(--bg)", border: "1px solid var(--border)",
                padding: "10px 14px", maxHeight: 240, overflow: "auto",
                fontFamily: "var(--font-mono)",
              }}>
                {story.logs && story.logs.length > 0 ? (
                  story.logs.map((l, i) => <LogEntry key={i} log={l}/>)
                ) : (
                  <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "8px 0", textAlign: "center", letterSpacing: "0.08em" }}>No log events — story is {story.status}.</div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                {["View logs", "Retry", "Amend…"].map(l => (
                  <button key={l} style={{
                    fontSize: 10, padding: "7px 14px",
                    border: "1px solid var(--border-2)", color: "var(--text-dim)",
                    letterSpacing: "0.14em", textTransform: "uppercase",
                    background: "transparent",
                  }}>{l}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WaveRow({ epic, wave, exp, setExp, storyExp, setStoryExp }) {
  const open = exp[wave.id];
  const agg = aggregateWave(wave);
  const pct = Math.round(agg.progress);
  const isParallel = wave.stories.length > 1;
  const anyRunning = agg.running > 0;

  return (
    <div>
      <div
        onClick={() => setExp(p => ({ ...p, [wave.id]: !p[wave.id] }))}
        style={{
          display: "grid",
          gridTemplateColumns: "20px 100px 1fr auto auto auto auto auto",
          alignItems: "center", gap: 14,
          padding: "10px 18px 10px 36px",
          cursor: "pointer",
          background: "transparent",
          borderTop: "1px solid var(--border)",
          transition: "background 120ms",
        }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      >
        <span style={{ fontSize: 9, color: "var(--text-mute)", transition: "transform 160ms", transform: open ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--purple)", textTransform: "uppercase", letterSpacing: "0.22em" }}>
          {wave.label}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)", letterSpacing: "0.005em" }}>
            {wave.stories.length} {wave.stories.length === 1 ? "story" : "stories"}
            {isParallel && <span className="mono" style={{ color: "var(--purple)", marginLeft: 12, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.22em" }}>∥ parallel</span>}
          </span>
        </div>

        <div style={{ width: 120, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: "var(--border)", overflow: "hidden" }}>
            <div style={{
              width: `${pct}%`, height: "100%",
              background: anyRunning ? "var(--purple)" : "var(--green)",
              transition: "width 300ms",
              opacity: anyRunning ? 1 : 0.7,
            }}/>
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-mute)", minWidth: 28, textAlign: "right" }}>{pct}%</span>
        </div>

        <MetricChip label="time" value={fmtSec(agg.actual) + " / " + fmtSec(agg.planned)} color="var(--text-dim)" />
        <MetricChip label="tokens" value={fmtTokens(agg.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(agg.cost)} color="var(--amber)" />
        <span className="mono" style={{ fontSize: 10, color: "var(--text-mute)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{agg.done}/{agg.total}</span>
      </div>

      {open && wave.stories.map(s => (
        <StoryRow
          key={s.id}
          story={s}
          expanded={storyExp[s.id]}
          onToggle={() => setStoryExp(p => ({ ...p, [s.id]: !p[s.id] }))}
        />
      ))}
    </div>
  );
}

function EpicCard({ epic, exp, setExp, storyExp, setStoryExp }) {
  const open = exp[epic.id];
  const agg = aggregateEpic(epic);
  const pct = Math.round(agg.progress);
  const statusColor = epic.status === "completed" ? "var(--green)"
    : epic.status === "in_progress" ? "var(--purple)"
    : epic.status === "fixing" ? "var(--red)"
    : epic.status === "failed" ? "var(--red)"
    : "var(--text-mute)";

  return (
    <div style={{
      marginBottom: 1,
      background: "transparent",
      border: "1px solid var(--border)",
      overflow: "hidden",
      transition: "border-color 150ms",
    }}>
      <div
        onClick={() => setExp(p => ({ ...p, [epic.id]: !p[epic.id] }))}
        style={{
          display: "grid",
          gridTemplateColumns: "20px auto 1fr auto auto auto auto auto auto",
          alignItems: "center", gap: 14,
          padding: "14px 18px",
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-mute)", transition: "transform 160ms", transform: open ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
        <span className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.22em" }}>
          PW{epic.planWave}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 5 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", letterSpacing: "0.08em" }}>{epic.id.toUpperCase()}</span>
            <span style={{ fontSize: 17, fontWeight: 300, color: "var(--text)", letterSpacing: "-0.005em" }}>{epic.label}</span>
            <span className="mono" style={{ fontSize: 9, color: statusColor, textTransform: "uppercase", letterSpacing: "0.22em" }}>
              {epic.status.replace("_", " ")}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.005em" }}>
            {epic.goal}
            {epic.dependsOn.length > 0 && <span className="mono" style={{ color: "var(--text-faint)", marginLeft: 14, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase" }}>→ {epic.dependsOn.join(", ")}</span>}
          </div>
        </div>

        <div style={{ width: 140, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: "var(--border)", overflow: "hidden" }}>
            <div style={{
              width: `${pct}%`, height: "100%",
              background: statusColor,
              transition: "width 300ms",
              opacity: agg.running ? 1 : 0.7,
            }}/>
          </div>
          <span className="mono" style={{ fontSize: 10, color: statusColor, minWidth: 32, textAlign: "right", letterSpacing: "0.02em" }}>{pct}%</span>
        </div>

        <MetricChip label="time" value={fmtSec(agg.actual) + " / " + fmtSec(agg.planned)} color="var(--text-dim)" />
        <MetricChip label="waves" value={String(epic.waves.length)} color="var(--text-dim)" />
        <MetricChip label="tokens" value={fmtTokens(agg.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(agg.cost)} color="var(--amber)" />
        <span className="mono" style={{ fontSize: 12, color: "var(--text)", fontWeight: 400, letterSpacing: "0.02em" }}>{agg.done}/{agg.total}</span>
      </div>

      {open && (
        <div style={{ background: "rgba(255,255,255,0.008)" }}>
          {epic.waves.map(w => (
            <WaveRow key={w.id} epic={epic} wave={w} exp={exp} setExp={setExp} storyExp={storyExp} setStoryExp={setStoryExp} />
          ))}
        </div>
      )}
    </div>
  );
}

function HierarchyView() {
  const initial = useStateH(() => {
    const o = {};
    PLAN.epics.forEach(e => { o[e.id] = e.status === "in_progress"; e.waves.forEach(w => { o[w.id] = e.status === "in_progress"; }); });
    return o;
  })[0];
  const [exp, setExp] = useStateH(initial);
  const [storyExp, setStoryExp] = useStateH({});
  const agg = aggregatePlan(PLAN);

  return (
    <div>
      {/* Plan-level rollup */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(6, 1fr)",
        marginBottom: 28,
        padding: "24px 28px",
        border: "1px solid var(--border)",
      }}>
        {[
          { label: "Plan time", value: fmtSec(agg.actual) + " / " + fmtSec(agg.planned), color: "var(--text)" },
          { label: "Stories done", value: `${agg.done} / ${agg.total}`, color: "var(--green)" },
          { label: "In flight", value: String(agg.running), color: "var(--purple)" },
          { label: "Epics", value: String(PLAN.epics.length), color: "var(--blue)" },
          { label: "Tokens", value: fmtTokens(agg.tokens), color: "var(--cyan)" },
          { label: "Cost", value: fmtCost(agg.cost), color: "var(--amber)" },
        ].map((m, i) => (
          <div key={m.label} style={{ paddingLeft: i === 0 ? 0 : 20, borderLeft: i === 0 ? "none" : "1px solid var(--border)" }}>
            <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.24em", marginBottom: 10 }}>{m.label}</div>
            <div className="mono" style={{ fontSize: 24, color: m.color, fontWeight: 300, letterSpacing: "-0.01em" }}>{m.value}</div>
          </div>
        ))}
      </div>

      {PLAN.epics.map(e => (
        <EpicCard key={e.id} epic={e} exp={exp} setExp={setExp} storyExp={storyExp} setStoryExp={setStoryExp} />
      ))}
    </div>
  );
}

window.HierarchyView = HierarchyView;
window.StatusPill = StatusPill;
