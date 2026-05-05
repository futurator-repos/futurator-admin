/* global React, PLAN, STORY_STATUS, fmtSec, fmtCost, fmtTokens */
const { useState: useStateG, useEffect: useEffectG, useRef: useRefG, useCallback: useCallbackG, useMemo: useMemoG } = React;

// ───────────────────────────────────────────────────────────────────
// Gantt — adapted from the uploaded reference, wired to the PLAN data.
// Keeps the "projected end = now for overrunning stories" insight:
// downstream bars slide right in real-time as blockers overrun.
// Bars are clickable → open a rich side drawer.
// ───────────────────────────────────────────────────────────────────

const SP_UNIT = 6;         // 1 SP ≈ 6 sim-seconds (slightly faster than ref so the timeline fits)
const WAVE_GAP = 1.2;
const EPIC_GAP = 2.0;

// Build simulator-friendly defs from PLAN
function buildSimDefs() {
  return PLAN.epics.map(e => ({
    id: e.id, label: `${e.id} — ${e.label}`,
    epicStatus: e.status,
    waves: e.waves.map((w, wi) => ({
      id: w.id, label: w.label,
      stories: w.stories.map(s => ({
        id: s.id, label: s.label, sp: s.sp,
        // derive a "speedFactor" that reflects story's current state,
        // so reviewers can see what-if execution timeline vs plan
        speedFactor: s.status === "running" && (s.progress || 0) < 50 ? 0.7
                    : s.status === "fixing" ? 0.55
                    : s.status === "running" ? 0.9
                    : 1.0,
        status: s.status,
        tool: s.touchPoints && s.touchPoints.length > 2 ? "MULTI" : null,
        desc: s.desc,
        cost: s.cost, tokens: s.tokens,
        plannedSec: s.plannedSec, actualSec: s.actualSec,
        wave: wi,
        originalStory: s,
      })),
    })),
  }));
}

function simulateGantt(t, defs) {
  const stories = {};
  let cursor = 0, plannedCursor = 0;
  for (const epic of defs) {
    for (const wave of epic.waves) {
      const storyList = [];
      for (const def of wave.stories) {
        const plannedDur = def.sp * SP_UNIT;
        const plannedStart = plannedCursor;
        const plannedEnd = plannedCursor + plannedDur;
        const actualStart = cursor;
        let status, progress, isOverrunning, barWidth, projectedEnd, actualDur;

        if (t < actualStart) {
          status = "queued"; progress = 0; isOverrunning = false; barWidth = plannedDur;
          projectedEnd = actualStart + plannedDur; actualDur = null;
        } else {
          const elapsed = t - actualStart;
          const workDone = elapsed * def.speedFactor;
          if (workDone >= plannedDur) {
            status = "done"; progress = 100;
            actualDur = plannedDur / def.speedFactor;
            barWidth = actualDur;
            projectedEnd = actualStart + actualDur;
            isOverrunning = false;
          } else {
            status = "running";
            progress = (workDone / plannedDur) * 100;
            isOverrunning = elapsed > plannedDur;
            barWidth = Math.max(plannedDur, elapsed);
            actualDur = null;
            projectedEnd = isOverrunning ? t : actualStart + plannedDur;
          }
        }
        const cost = def.sp * 0.28 * (progress / 100);
        const displacement = actualStart - plannedStart;
        const wasLate = status === "done" && actualDur > plannedDur * 1.05;

        const entry = {
          ...def, plannedStart, plannedEnd, plannedDur,
          actualStart, actualDur, barWidth, projectedEnd,
          progress, simStatus: status, isOverrunning, wasLate, cost, displacement,
          epicId: epic.id, waveId: wave.id,
        };
        stories[def.id] = entry;
        storyList.push(entry);
      }
      const waveEnd = Math.max(...storyList.map(s => s.projectedEnd));
      const wavePlannedEnd = Math.max(...storyList.map(s => s.plannedEnd));
      cursor = waveEnd + WAVE_GAP;
      plannedCursor = wavePlannedEnd + WAVE_GAP;
    }
    cursor += EPIC_GAP;
    plannedCursor += EPIC_GAP;
  }
  const allStories = Object.values(stories);
  const totalPlanned = allStories.length ? Math.max(...allStories.map(s => s.plannedEnd)) : 0;
  const totalActual = allStories.length ? Math.max(...allStories.map(s => s.projectedEnd)) : 0;
  const totalTime = Math.max(totalPlanned * 1.35, totalActual + 4);
  const allDone = allStories.length > 0 && allStories.every(s => s.simStatus === "done");
  return { stories, allStories, totalPlanned, totalActual, totalTime, allDone };
}

function fmtClock(s) { const m = Math.floor(s / 60); const sc = Math.floor(s % 60); return `${m}:${sc < 10 ? "0" : ""}${sc}`; }

function stColorG(s) {
  if (s.simStatus === "queued") return "#3e4a5c";
  if (s.simStatus === "done") return s.wasLate ? "#f59e0b" : "#22c55e";
  if (s.isOverrunning) return "#ef4444";
  return "#a78bfa";
}
function barGradientG(s) {
  if (s.simStatus === "queued") return "#1e293b";
  if (s.simStatus === "done") return s.wasLate ? "linear-gradient(90deg,#b45309,#f59e0b)" : "linear-gradient(90deg,#059669,#22c55e)";
  if (s.isOverrunning) return "linear-gradient(90deg,#b91c1c,#ef4444)";
  return "linear-gradient(90deg,#7c3aed,#a78bfa)";
}

const TC = { plan: "#f59e0b", epic: "#3b82f6", wave: "#8b5cf6" };
const TI = { plan: "◆", epic: "■", wave: "⧫" };

function GanttStoryBar({ story, totalTime, onSelect }) {
  const toP = v => (v / totalTime) * 100;
  const sc = stColorG(story);
  const bg = barGradientG(story);
  const shadow = story.isOverrunning ? "0 0 18px rgba(239,68,68,0.35)"
    : story.simStatus === "running" ? "0 0 10px rgba(167,139,250,0.22)" : "none";
  const pL = toP(story.plannedStart), pW = toP(story.plannedDur);
  const aL = toP(story.actualStart), aW = toP(story.barWidth);
  const fillPct = story.progress;
  const showGhost = (story.displacement > 0.3) || (story.simStatus !== "queued" && story.barWidth > story.plannedDur + 0.1);

  return (
    <div style={{ position: "relative", height: 28, marginBottom: 1 }}>
      {showGhost && (
        <div style={{ position: "absolute", left: `${pL}%`, width: `${pW}%`, top: 3, height: 22, borderRadius: 4, border: "1px dashed #33415588", pointerEvents: "none", zIndex: 0 }}/>
      )}
      {showGhost && story.displacement > 0.5 && story.simStatus !== "queued" && (
        <div style={{ position: "absolute", left: `${pL + pW}%`, width: `${aL - (pL + pW)}%`, top: 14, height: 2, background: "linear-gradient(90deg,#33415566,#f59e0b88)", pointerEvents: "none", zIndex: 0 }}>
          <div style={{ position: "absolute", right: -4, top: -3, width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "6px solid #f59e0b" }}/>
        </div>
      )}
      <div
        onClick={(e) => { e.stopPropagation(); onSelect(story); }}
        title="Click for details"
        style={{
          position: "absolute", left: `${aL}%`, width: `${Math.max(aW, 0.2)}%`,
          top: 3, height: 22, borderRadius: 4,
          background: "#131c2e",
          border: `1px solid ${sc}40`,
          overflow: "hidden", boxShadow: shadow, cursor: "pointer", zIndex: 1,
          transition: "border-color 0.2s, box-shadow 0.2s",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = sc}
        onMouseLeave={e => e.currentTarget.style.borderColor = `${sc}40`}
      >
        <div style={{ height: "100%", width: `${fillPct}%`, background: bg, borderRadius: 3, transition: "background 0.4s" }}/>
        <div style={{ position: "absolute", top: 0, left: 8, right: 4, height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, fontFamily: "var(--font-mono)", color: "#e6edf7", pointerEvents: "none", gap: 4 }}>
          <span style={{ opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>
            {story.label}
            {story.isOverrunning && <span style={{ fontSize: 9, color: "#fecaca", animation: "pulse 1s infinite" }}>⚠</span>}
          </span>
          <span style={{ opacity: 0.55, flexShrink: 0, fontSize: 9 }}>
            {story.simStatus !== "queued" && <>{fmtClock(story.barWidth)} · ${story.cost.toFixed(2)}</>}
          </span>
        </div>
      </div>
    </div>
  );
}

function GanttAggBar({ stories, color, totalTime }) {
  if (!stories.length) return null;
  const toP = v => (v / totalTime) * 100;
  const as0 = Math.min(...stories.map(s => s.actualStart));
  const as1 = Math.max(...stories.map(s => s.actualStart + s.barWidth));
  const ps1 = Math.max(...stories.map(s => s.plannedEnd));
  const pr = stories.reduce((a, s) => a + s.progress, 0) / stories.length;
  const co = stories.reduce((a, s) => a + s.cost, 0);
  const anyStress = stories.some(s => s.isOverrunning);
  const anyLate = stories.some(s => s.wasLate);
  const disp = as1 - ps1;
  const bc = anyStress ? "#ef4444" : (anyLate || disp > 1 ? "#f59e0b" : color);
  return (
    <div style={{ position: "relative", height: 22, marginBottom: 1 }}>
      <div style={{
        position: "absolute", left: `${toP(as0)}%`, width: `${Math.max(toP(as1 - as0), 0.5)}%`,
        top: 2, height: 18, borderRadius: 3,
        background: "#0c1322", border: `1px solid ${bc}30`, overflow: "hidden",
      }}>
        <div style={{ height: "100%", width: `${pr}%`, background: `linear-gradient(90deg,${bc}40,${bc}18)`, borderRadius: 2 }}/>
        <div style={{ position: "absolute", top: 0, right: 8, height: "100%", display: "flex", alignItems: "center", gap: 8, fontSize: 9, fontFamily: "var(--font-mono)", color: bc, opacity: 0.85 }}>
          {disp > 1 && <span style={{ color: "#f59e0b", fontSize: 8 }}>+{fmtClock(disp)}</span>}
          <span>{Math.round(pr)}% · ${co.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function GanttTimeRuler({ t, totalTime }) {
  const step = totalTime > 180 ? 20 : totalTime > 120 ? 15 : 10;
  const marks = []; for (let i = 0; i <= totalTime + step; i += step) marks.push(i);
  const toP = v => (v / totalTime) * 100;
  return (
    <div style={{ display: "flex", height: 26, borderBottom: "2px solid var(--border)", background: "#060a14" }}>
      <div style={{ width: 300, minWidth: 300, borderRight: "1px solid var(--border)", display: "flex", alignItems: "center", paddingLeft: 16, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Timeline</div>
      <div style={{ flex: 1, position: "relative" }}>
        {marks.filter(m => m <= totalTime).map(m => (
          <div key={m} style={{ position: "absolute", left: `${toP(m)}%`, top: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
            <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", color: m % (step * 3) === 0 ? "#64748b" : "#2d3a4f", marginBottom: 2 }}>{fmtClock(m)}</span>
            <div style={{ width: 1, height: m % (step * 3) === 0 ? 8 : 4, background: m % (step * 3) === 0 ? "#334155" : "#1a2236" }}/>
          </div>
        ))}
        <div style={{ position: "absolute", left: `${Math.min(toP(t), 100)}%`, top: 0, bottom: -2, width: 2, background: "var(--amber)", borderRadius: 1, boxShadow: "0 0 8px #f59e0b66", zIndex: 10 }}>
          <div style={{ position: "absolute", top: -2, left: -5, width: 12, height: 6, background: "var(--amber)", borderRadius: "2px 2px 0 0" }}/>
        </div>
      </div>
    </div>
  );
}

function GanttScrubber({ t, totalTime, onSeek }) {
  const ref = useRefG(null); const drag = useRefG(false);
  const calc = useCallbackG(e => { const r = ref.current.getBoundingClientRect(); onSeek(Math.max(0, Math.min(totalTime, ((e.clientX - r.left) / r.width) * totalTime))); }, [onSeek, totalTime]);
  useEffectG(() => {
    const mv = e => { if (drag.current) calc(e); };
    const up = () => { drag.current = false; };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
  }, [calc]);
  const toP = v => Math.min((v / totalTime) * 100, 100);
  return (
    <div ref={ref} onMouseDown={e => { drag.current = true; calc(e); }} style={{ height: 8, background: "#0c1322", cursor: "pointer", position: "relative", borderTop: "1px solid var(--border)" }}>
      <div style={{ height: "100%", width: `${toP(t)}%`, background: "linear-gradient(90deg,#f59e0b33,#f59e0b77)" }}/>
      <div style={{ position: "absolute", top: -4, left: `${toP(t)}%`, width: 14, height: 14, borderRadius: "50%", background: "var(--amber)", border: "2px solid var(--bg)", transform: "translateX(-7px)", boxShadow: "0 0 10px #f59e0b66" }}/>
    </div>
  );
}

function GanttGrid({ t, totalTime }) {
  const step = totalTime > 180 ? 20 : totalTime > 120 ? 15 : 10;
  const lines = []; for (let i = 0; i <= totalTime + step; i += step) lines.push(i);
  const toP = v => (v / totalTime) * 100;
  return (
    <div style={{ position: "absolute", top: 0, left: 300, right: 0, bottom: 0, pointerEvents: "none", zIndex: 0 }}>
      {lines.filter(i => i <= totalTime).map(i => (
        <div key={i} style={{ position: "absolute", left: `${toP(i)}%`, top: 0, bottom: 0, width: 1, background: i % (step * 3) === 0 ? "#151d2e66" : "#0e152511" }}/>
      ))}
      <div style={{ position: "absolute", left: `${Math.min(toP(t), 100)}%`, top: 0, bottom: 0, width: 1, background: "#f59e0b1a", zIndex: 1 }}/>
    </div>
  );
}

// Story detail drawer (replaces the reference's popover)
function GanttDrawer({ story, onClose }) {
  const orig = story.originalStory;
  const sc = stColorG(story);
  const isOver = story.simStatus === "done" ? story.wasLate : story.isOverrunning;
  const durRatio = story.actualDur ? story.actualDur / story.plannedDur : null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, animation: "slideDown 160ms" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: 480,
          background: "var(--bg-elev)", borderLeft: "1px solid var(--border)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: "-20px 0 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span className="dot" style={{ background: sc, marginTop: 7, boxShadow: `0 0 10px ${sc}88` }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{ fontSize: 11, color: sc, fontWeight: 700 }}>{story.id}</span>
              <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", padding: "1px 5px", borderRadius: 3, background: "var(--surface)", border: "1px solid var(--border)" }}>{story.epicId}</span>
              <span className="mono" style={{ fontSize: 9, color: "var(--purple)", padding: "1px 5px", borderRadius: 3, background: "#8b5cf615", border: "1px solid #8b5cf625" }}>{story.waveId}</span>
              <span className="mono" style={{ fontSize: 9, color: sc, textTransform: "uppercase", letterSpacing: "0.08em", marginLeft: "auto" }}>{story.simStatus}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", textWrap: "pretty", lineHeight: 1.3 }}>{story.label}</div>
          </div>
          <button onClick={onClose} style={{ color: "var(--text-mute)", fontSize: 18, flexShrink: 0, padding: 4 }}>✕</button>
        </div>

        <div style={{ padding: 20, overflow: "auto", flex: 1 }}>
          <p style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 18, textWrap: "pretty" }}>{story.desc}</p>

          {/* Estimate accuracy */}
          <div style={{ marginBottom: 18 }}>
            <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Estimate accuracy</div>
            <div style={{ height: 10, background: "var(--border)", borderRadius: 5, overflow: "hidden", display: "flex" }}>
              <div style={{
                width: `${Math.min(100, (story.plannedDur / Math.max(story.barWidth, story.plannedDur)) * 100)}%`,
                background: "linear-gradient(90deg,#059669,#22c55e)",
              }}/>
              <div style={{
                flex: 1,
                background: story.isOverrunning ? "linear-gradient(90deg,#b91c1c,#ef4444)"
                          : story.wasLate ? "linear-gradient(90deg,#b45309,#f59e0b)" : "transparent",
              }}/>
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 4, display: "flex", justifyContent: "space-between" }}>
              <span>planned {fmtClock(story.plannedDur)}</span>
              <span style={{ color: isOver ? "var(--red)" : "var(--text-mute)" }}>
                {story.actualDur ? `actual ${fmtClock(story.actualDur)}` : story.simStatus === "running" ? `${fmtClock(story.barWidth)} elapsed…` : "not started"}
              </span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
            {[
              { l: "Status",      v: story.simStatus.toUpperCase(),         c: sc },
              { l: "Story points",v: `${story.sp} SP`,                       c: "var(--text)" },
              { l: "Planned",     v: fmtClock(story.plannedDur),             c: "var(--text-mute)" },
              { l: "Actual",      v: story.actualDur ? fmtClock(story.actualDur) : story.simStatus === "running" ? `${fmtClock(story.barWidth)} so far` : "—", c: isOver ? "var(--amber)" : "var(--text)" },
              { l: "Progress",    v: `${Math.round(story.progress)}%`,       c: "var(--purple)" },
              { l: "Cost",        v: `$${story.cost.toFixed(2)}`,             c: "var(--amber)" },
              { l: "Displaced",   v: story.displacement > 0.5 ? `+${fmtClock(story.displacement)}` : "None", c: story.displacement > 0.5 ? "var(--amber)" : "var(--green)" },
              { l: "Overrun",     v: durRatio ? `${durRatio.toFixed(2)}×` : story.isOverrunning ? "active" : "—", c: isOver ? "var(--red)" : "var(--text-mute)" },
            ].map(m => (
              <div key={m.l} style={{ padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
                <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>{m.l}</div>
                <div className="mono" style={{ fontSize: 13, color: m.c, fontWeight: 600 }}>{m.v}</div>
              </div>
            ))}
          </div>

          {orig && orig.criteria && orig.criteria.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Acceptance criteria</div>
              {orig.criteria.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "4px 0" }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${c.done ? "var(--green)" : "var(--border-2)"}`, background: c.done ? "var(--green-soft)" : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--green)", fontSize: 10 }}>{c.done ? "✓" : ""}</span>
                  <span style={{ color: c.done ? "var(--text-dim)" : "var(--text)" }}>{c.text}</span>
                </div>
              ))}
            </div>
          )}

          {orig && orig.logs && orig.logs.length > 0 && (
            <div>
              <div className="mono" style={{ fontSize: 8, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Recent activity</div>
              <div style={{ background: "#060a12", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px", maxHeight: 180, overflow: "auto" }}>
                {orig.logs.map((l, i) => (
                  <div key={i} style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-dim)", padding: "2px 0", display: "flex", gap: 8 }}>
                    <span style={{ color: "var(--text-faint)", width: 42, flexShrink: 0 }}>{l.t}</span>
                    <span style={{ color: "var(--cyan)", width: 60, flexShrink: 0, fontSize: 9, textTransform: "uppercase" }}>{l.type.replace("_", " ")}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <button style={{ fontSize: 12, padding: "8px 14px", borderRadius: 5, background: "var(--green-soft)", border: "1px solid var(--green)", color: "var(--green)", fontWeight: 600 }}>Open in Hierarchy</button>
          <button style={{ fontSize: 12, padding: "8px 14px", borderRadius: 5, background: "var(--surface)", border: "1px solid var(--border-2)", color: "var(--text)" }}>Retry</button>
          <button style={{ fontSize: 12, padding: "8px 14px", borderRadius: 5, background: "var(--surface)", border: "1px solid var(--border-2)", color: "var(--text)" }}>Amend…</button>
        </div>
      </div>
    </div>
  );
}

function GanttTreeNode({ node, depth, exp, toggle, sim, onSel, showDeps, showPlannedGhost }) {
  const { stories: sm, totalTime } = sim;
  const isW = node.type === "wave", isE = node.type === "epic", isP = node.type === "plan";
  const hasCh = node.children && node.children.length > 0;
  const open = exp[node.id];
  const indent = depth * 18;

  let ns = [];
  if (isW) ns = node.storyIds.map(id => sm[id]).filter(Boolean);
  else if (isE) ns = node.children.flatMap(w => w.storyIds.map(id => sm[id]).filter(Boolean));
  else if (isP) ns = sim.allStories;

  const color = TC[node.type];

  return (
    <>
      <div style={{ display: "flex", minHeight: isW ? 30 : 34, borderBottom: "1px solid #111827" }}>
        <div style={{ width: 300, minWidth: 300, display: "flex", alignItems: "center", paddingLeft: 12 + indent, paddingRight: 10, borderRight: "1px solid var(--border)", cursor: hasCh ? "pointer" : "default", userSelect: "none", background: depth === 0 ? "#080d18" : "transparent" }} onClick={() => hasCh && toggle(node.id)}>
          {hasCh ? (<span style={{ width: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--text-faint)", marginRight: 4, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "rotate(0)" }}>▶</span>) : <span style={{ width: 20, flexShrink: 0 }}/>}
          <span style={{ color, fontSize: 10, marginRight: 8 }}>{TI[node.type]}</span>
          <span style={{ fontSize: isP ? 13 : isE ? 12 : 11, fontWeight: isP ? 700 : isE ? 600 : 500, color: "var(--text)", fontFamily: "var(--font-sans)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{node.label}</span>
          {isW && <span className="mono" style={{ marginLeft: 8, fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "#8b5cf612", color: "#8b5cf6", border: "1px solid #8b5cf625" }}>{ns.length}∥</span>}
        </div>
        <div style={{ flex: 1, position: "relative", padding: "3px 0" }}><GanttAggBar stories={ns} color={color} totalTime={totalTime}/></div>
      </div>
      {isW && open && ns.map(s => {
        const sc = stColorG(s);
        return (
          <div key={s.id} style={{ display: "flex", minHeight: 30, borderBottom: "1px solid #0e1525" }}>
            <div style={{ width: 300, minWidth: 300, display: "flex", alignItems: "center", paddingLeft: 12 + (depth + 1) * 18, paddingRight: 10, borderRight: "1px solid var(--border)" }}>
              <span style={{ width: 20, flexShrink: 0 }}/>
              <span style={{ color: sc, fontSize: 10, marginRight: 8 }}>●</span>
              <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{s.label}</span>
              {s.isOverrunning && <span style={{ marginLeft: 4, fontSize: 8, color: "var(--red)", animation: "pulse 1s infinite" }}>⚠</span>}
              <span className="mono" style={{ marginLeft: 4, fontSize: 7, padding: "1px 4px", borderRadius: 3, background: "var(--surface)", color: "var(--text-mute)", border: "1px solid var(--border)", flexShrink: 0 }}>{s.sp}SP</span>
            </div>
            <div style={{ flex: 1, position: "relative", padding: "2px 0" }}><GanttStoryBar story={s} totalTime={sim.totalTime} onSelect={onSel}/></div>
          </div>
        );
      })}
      {hasCh && open && node.children.map(ch => (
        <GanttTreeNode key={ch.id} node={ch} depth={depth + 1} exp={exp} toggle={toggle} sim={sim} onSel={onSel} showDeps={showDeps} showPlannedGhost={showPlannedGhost}/>
      ))}
    </>
  );
}

function buildGanttTree(defs) {
  return {
    id: "plan", type: "plan", label: `${PLAN.name} — ${PLAN.intent}`,
    children: defs.map(e => ({
      id: e.id, type: "epic", label: e.label,
      children: e.waves.map(w => ({ id: w.id, type: "wave", label: w.label, storyIds: w.stories.map(s => s.id) })),
    })),
  };
}

function GanttView() {
  const simDefs = useMemoG(buildSimDefs, []);
  const tree = useMemoG(() => buildGanttTree(simDefs), [simDefs]);
  const [t, setT] = useStateG(0);
  const [playing, setPlaying] = useStateG(false);
  const [speed, setSpeed] = useStateG(2);
  const [exp, setExp] = useStateG(() => {
    const e = { plan: true };
    simDefs.forEach(ep => { e[ep.id] = true; ep.waves.forEach(w => { e[w.id] = true; }); });
    return e;
  });
  const [sel, setSel] = useStateG(null);
  const animRef = useRefG(null);
  const lastRef = useRefG(null);

  const sim = useMemoG(() => simulateGantt(t, simDefs), [t, simDefs]);

  const SIM_REAL = 90;
  const initialPlanned = useMemoG(() => simulateGantt(0, simDefs).totalPlanned, [simDefs]);
  const simScale = initialPlanned / SIM_REAL;

  useEffectG(() => {
    if (!playing) { lastRef.current = null; return; }
    const tick = (now) => {
      if (lastRef.current !== null) {
        const dtReal = (now - lastRef.current) / 1000 * speed;
        const dtSim = dtReal * simScale;
        setT(prev => {
          const n = prev + dtSim;
          const s = simulateGantt(n, simDefs);
          if (s.allDone) { setPlaying(false); return s.totalActual; }
          return n;
        });
      }
      lastRef.current = now;
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animRef.current); lastRef.current = null; };
  }, [playing, speed, simScale, simDefs]);

  const toggle = id => setExp(p => ({ ...p, [id]: !p[id] }));
  const done = sim.allStories.filter(s => s.simStatus === "done").length;
  const running = sim.allStories.filter(s => s.simStatus === "running").length;
  const queued = sim.allStories.filter(s => s.simStatus === "queued").length;
  const stressed = sim.allStories.filter(s => s.isOverrunning).length;
  const totalCost = sim.allStories.reduce((a, s) => a + s.cost, 0);
  const overallProg = sim.allStories.length ? sim.allStories.reduce((a, s) => a + s.progress, 0) / sim.allStories.length : 0;
  const totalDisp = sim.totalActual - sim.totalPlanned;

  return (
    <div style={{ background: "#070c16", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", background: "linear-gradient(135deg,#080d18,#0f172a)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <button
          onClick={playing ? () => setPlaying(false) : () => { if (sim.allDone) setT(0); setPlaying(true); }}
          style={{ width: 40, height: 40, borderRadius: "50%", border: "2px solid #f59e0b55", background: playing ? "#f59e0b22" : "#f59e0b0a", color: "var(--amber)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: playing ? "0 0 20px #f59e0b33" : "none" }}
        >{playing ? "⏸" : "▶"}</button>
        <button onClick={() => { setPlaying(false); setT(0); setSel(null); }} style={{ width: 30, height: 30, borderRadius: "50%", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-mute)", fontSize: 12 }}>↺</button>
        <div style={{ display: "flex", gap: 3 }}>
          {[1, 2, 4, 8].map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{ padding: "4px 9px", borderRadius: 4, border: "1px solid", borderColor: speed === s ? "#f59e0b44" : "var(--border)", background: speed === s ? "#f59e0b12" : "transparent", color: speed === s ? "var(--amber)" : "var(--text-faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{s}×</button>
          ))}
        </div>
        <div className="mono" style={{ padding: "5px 14px", borderRadius: 6, background: "var(--surface)", border: "1px solid var(--border)", fontSize: 18, fontWeight: 700, color: "var(--text)", minWidth: 70, textAlign: "center" }}>{fmtClock(t)}</div>

        <div style={{ position: "relative", width: 40, height: 40 }}>
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="17" fill="none" stroke="var(--border)" strokeWidth="3"/>
            <circle cx="20" cy="20" r="17" fill="none" stroke={overallProg >= 99.9 ? "var(--green)" : stressed > 0 ? "var(--red)" : "var(--purple)"} strokeWidth="3" strokeDasharray={`${(overallProg / 100) * 106.8} 106.8`} strokeLinecap="round" transform="rotate(-90 20 20)"/>
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{Math.round(overallProg)}%</div>
        </div>

        <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
          {[{ l: "Done", v: done, c: "var(--green)" }, { l: "Live", v: running, c: "var(--purple)" }, { l: "Stress", v: stressed, c: "var(--red)" }, { l: "Queue", v: queued, c: "var(--text-faint)" }].map(s => (
            <div key={s.l} style={{ textAlign: "center", padding: "3px 8px", borderRadius: 5, background: `${s.c}12`, border: `1px solid ${s.c}25`, minWidth: 38 }}>
              <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: s.c }}>{s.v}</div>
              <div className="mono" style={{ fontSize: 7, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.l}</div>
            </div>
          ))}
          <div style={{ textAlign: "center", padding: "3px 8px", borderRadius: 5, background: "#f59e0b10", border: "1px solid #f59e0b22", minWidth: 52 }}>
            <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--amber)" }}>${totalCost.toFixed(2)}</div>
            <div className="mono" style={{ fontSize: 7, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cost</div>
          </div>
          {totalDisp > 0.5 && (
            <div style={{ textAlign: "center", padding: "3px 8px", borderRadius: 5, background: "#ef444410", border: "1px solid #ef444425", minWidth: 52 }}>
              <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>+{fmtClock(totalDisp)}</div>
              <div className="mono" style={{ fontSize: 7, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Slip</div>
            </div>
          )}
        </div>
      </div>

      <GanttScrubber t={t} totalTime={sim.totalTime} onSeek={v => { setT(v); setPlaying(false); }}/>
      <div style={{ position: "relative" }}>
        <GanttTimeRuler t={t} totalTime={sim.totalTime}/>
        <div style={{ position: "relative", minWidth: 900 }}>
          <GanttGrid t={t} totalTime={sim.totalTime}/>
          <GanttTreeNode node={tree} depth={0} exp={exp} toggle={toggle} sim={sim} onSel={setSel}/>
        </div>
      </div>

      <div className="mono" style={{ display: "flex", gap: 14, padding: "10px 20px", borderTop: "1px solid var(--border)", background: "#060a14", fontSize: 9, color: "var(--text-faint)", flexWrap: "wrap" }}>
        <span><span style={{ color: "var(--purple)" }}>━</span> Developing</span>
        <span><span style={{ color: "var(--green)" }}>━</span> Done on time</span>
        <span><span style={{ color: "var(--red)" }}>━</span> Overrunning now</span>
        <span><span style={{ color: "var(--amber)" }}>━</span> Done late</span>
        <span><span style={{ color: "#334155" }}>┅</span> Planned position</span>
        <span style={{ marginLeft: "auto" }}>Downstream stories slide right as upstream overruns · click any bar for details</span>
      </div>

      {sel && <GanttDrawer story={sel} onClose={() => setSel(null)}/>}
    </div>
  );
}

window.GanttView = GanttView;
