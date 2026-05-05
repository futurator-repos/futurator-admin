import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/*
 * ═══════════════════════════════════════════════════════════════════
 *  THE KEY INSIGHT
 * ═══════════════════════════════════════════════════════════════════
 *
 *  We do NOT know when a story will actually finish. The speedFactor
 *  is hidden — it only affects how fast progress accumulates per
 *  second of sim time.
 *
 *  At time t, for each story:
 *    - QUEUED  (t < actualStart):
 *        projectedEnd = actualStart + plannedDur  (assume on time)
 *    - RUNNING, within plan (elapsed <= plannedDur):
 *        projectedEnd = actualStart + plannedDur  (still assume on time)
 *    - RUNNING, past plan (elapsed > plannedDur):
 *        projectedEnd = t  (still going RIGHT NOW, who knows when it ends)
 *    - DONE (workDone >= plannedDur):
 *        projectedEnd = actualStart + (when it actually finished)
 *
 *  The wave's projected end = max(projectedEnd) of its stories.
 *  The next wave's actualStart = that projected end + gap.
 *
 *  KEY CONSEQUENCE: When a story is overrunning, its projectedEnd = t.
 *  Since t grows by ~1 every real second, the wave's projected end
 *  grows by ~1 every second, and every downstream story's actualStart
 *  grows by ~1 every second. THEY SLIDE RIGHT IN REAL-TIME.
 *
 *  The moment the slow story finishes, its projectedEnd freezes at
 *  its actual completion time, and downstream positions stabilize.
 * ═══════════════════════════════════════════════════════════════════
 */

const SP_UNIT = 7;
const WAVE_GAP = 1.5;
const EPIC_GAP = 2.5;

const EPIC_DEFS = [
  {
    id: "e1", label: "Core Infrastructure",
    waves: [
      { id: "w1-1", label: "Wave 1 — Bootstrap", stories: [
        { id:"s1", label:"ECS Cluster Provision", sp:2,   speedFactor:1.0, tool:"BROWSER", desc:"Provision ECS Fargate cluster in eu-central-1." },
        { id:"s2", label:"DynamoDB Schema Init",  sp:1.5, speedFactor:1.0, tool:null,      desc:"Create DynamoDB tables with GSIs." },
      ]},
      { id: "w1-2", label: "Wave 2 — Integration", stories: [
        { id:"s3", label:"API Gateway Routes",   sp:2, speedFactor:1.0,  tool:"BROWSER", desc:"Configure API Gateway REST endpoints." },
        { id:"s4", label:"Cognito Auth Flow",     sp:2, speedFactor:0.55, tool:null,      desc:"Cognito user pool with MFA. Will unexpectedly overrun." },
      ]},
    ],
  },
  {
    id: "e2", label: "Agent Pipeline Engine",
    waves: [
      { id: "w2-1", label: "Wave 1 — Foundation", stories: [
        { id:"s5", label:"Agent Base Class",    sp:2,   speedFactor:1.0, tool:null, desc:"Abstract base class for all agents." },
        { id:"s6", label:"Message Bus (SSE)",   sp:2.5, speedFactor:1.0, tool:null, desc:"SSE bus for agent communication." },
      ]},
      { id: "w2-2", label: "Wave 2 — Parallel Execution", stories: [
        { id:"s7",  label:"Six Hats Spawner",      sp:2.5, speedFactor:1.0, tool:"BROWSER", desc:"Spawn parallel Six Hats agents." },
        { id:"s8",  label:"Convergence Detector",   sp:2,   speedFactor:1.0, tool:null,      desc:"Detect agent consensus." },
        { id:"s9",  label:"Agent Health Monitor",    sp:2,   speedFactor:0.45, tool:null,     desc:"Zombie process edge cases — will heavily overrun." },
        { id:"s10", label:"Result Aggregator",       sp:2,   speedFactor:1.0, tool:"BROWSER", desc:"Aggregate parallel agent outputs." },
      ]},
      { id: "w2-3", label: "Wave 3 — Optimization", stories: [
        { id:"s11", label:"Token Budget Manager",   sp:1.5, speedFactor:1.0, tool:null, desc:"Per-agent token budget enforcement." },
        { id:"s12", label:"Retry & Failover Logic", sp:2,   speedFactor:1.0, tool:null, desc:"Exponential backoff with circuit breaker." },
      ]},
    ],
  },
  {
    id: "e3", label: "Data & Memory Layer",
    waves: [
      { id: "w3-1", label: "Wave 1 — Vector Store", stories: [
        { id:"s13a", label:"Embedding Pipeline",        sp:2,   speedFactor:1.0,  tool:"BROWSER", desc:"Voyage 4 embedding pipeline for agent memory ingestion." },
        { id:"s13b", label:"Memgraph Schema",            sp:1.5, speedFactor:0.5,  tool:null,      desc:"GraphRAG schema with relationship indexes — unexpected index bloat, heavy overrun incoming." },
      ]},
      { id: "w3-2", label: "Wave 2 — Retrieval", stories: [
        { id:"s13c", label:"Hybrid Semantic Search",     sp:2,   speedFactor:0.55, tool:null,      desc:"Combined vector + keyword search with re-ranking. Tuning re-ranker is much slower than estimated." },
        { id:"s13d", label:"Query Planner Cache",        sp:1.5, speedFactor:1.0,  tool:null,      desc:"LRU cache layer for frequent query patterns." },
        { id:"s13e", label:"Context Compaction",         sp:2,   speedFactor:1.0,  tool:null,      desc:"Sliding-window context compaction with summarization." },
      ]},
    ],
  },
  {
    id: "e4", label: "Orchestration Dashboard",
    waves: [
      { id: "w4-1", label: "Wave 1 — Components", stories: [
        { id:"s14", label:"Isometric Tile Component", sp:2,   speedFactor:1.0, tool:"BROWSER", desc:"3D tile renderer for agent status." },
        { id:"s15", label:"Animation Engine",          sp:1.5, speedFactor:1.0, tool:"BROWSER", desc:"Spring-based animation engine." },
        { id:"s16", label:"Game State Hook",           sp:1.5, speedFactor:1.0, tool:null,      desc:"React hook for orchestration state." },
      ]},
    ],
  },
];

// ─── simulate(t) ───────────────────────────────────────────────────
function simulate(t) {
  const stories = {};
  let cursor = 0;         // actual timeline cursor (shifts with live overruns)
  let plannedCursor = 0;  // planned timeline cursor (reference baseline)

  for (const epic of EPIC_DEFS) {
    for (const wave of epic.waves) {
      const storyList = [];

      for (const def of wave.stories) {
        const plannedDur = def.sp * SP_UNIT;
        const plannedStart = plannedCursor;
        const plannedEnd = plannedCursor + plannedDur;
        const actualStart = cursor;

        let status, progress, isOverrunning, barWidth, projectedEnd, actualDur;

        if (t < actualStart) {
          // QUEUED — not started yet. Project on-time finish.
          status = "queued";
          progress = 0;
          isOverrunning = false;
          barWidth = plannedDur;
          projectedEnd = actualStart + plannedDur;
          actualDur = null;
        } else {
          const elapsed = t - actualStart;
          const workDone = elapsed * def.speedFactor;

          if (workDone >= plannedDur) {
            // DONE — work completed. Actual duration = plannedDur / speedFactor.
            status = "done";
            progress = 100;
            actualDur = plannedDur / def.speedFactor;
            barWidth = actualDur;
            projectedEnd = actualStart + actualDur;
            isOverrunning = false;
          } else {
            // RUNNING — still in progress.
            status = "running";
            progress = (workDone / plannedDur) * 100;
            isOverrunning = elapsed > plannedDur;
            barWidth = Math.max(plannedDur, elapsed);
            actualDur = null;
            // ★ THE CRITICAL LINE ★
            // If overrunning: we don't know when it'll end. projectedEnd = t.
            // As t advances, projectedEnd grows → wave end grows → downstream slides right.
            projectedEnd = isOverrunning ? t : actualStart + plannedDur;
          }
        }

        const cost = def.sp * 0.28 * (progress / 100);
        const displacement = actualStart - plannedStart;
        const wasLate = status === "done" && actualDur > plannedDur * 1.05;

        const entry = {
          ...def,
          plannedStart, plannedEnd, plannedDur,
          actualStart, actualDur,
          barWidth, projectedEnd,
          progress, status,
          isOverrunning, wasLate,
          cost, displacement,
          epicId: epic.id, waveId: wave.id,
        };

        stories[def.id] = entry;
        storyList.push(entry);
      }

      // Wave's projected end = max of story projected ends
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
  // Fixed viewport sized generously. Expand only if severe overrun pushes past.
  const totalTime = Math.max(totalPlanned * 1.45, totalActual + 5);
  const allDone = allStories.length > 0 && allStories.every(s => s.status === "done");

  return { stories, allStories, totalPlanned, totalActual, totalTime, allDone };
}

// ─── Helpers ───────────────────────────────────────────────────────
function fmt(s) { const m=Math.floor(s/60); const sc=Math.floor(s%60); return `${m}:${sc<10?"0":""}${sc}`; }

function stColor(s) {
  if (s.status === "queued") return "#3e4a5c";
  if (s.status === "done") return s.wasLate ? "#f59e0b" : "#22c55e";
  if (s.isOverrunning) return "#ef4444";
  return "#a78bfa";
}

function barGradient(s) {
  if (s.status === "queued") return "#1e293b";
  if (s.status === "done") return s.wasLate
    ? "linear-gradient(90deg,#b45309,#f59e0b)"
    : "linear-gradient(90deg,#059669,#22c55e)";
  if (s.isOverrunning) return "linear-gradient(90deg,#b91c1c,#ef4444)";
  return "linear-gradient(90deg,#7c3aed,#a78bfa)";
}

const TC = { version:"#f59e0b", epic:"#3b82f6", wave:"#8b5cf6" };
const TI = { version:"◆", epic:"■", wave:"⧫" };

// ─── Popover ───────────────────────────────────────────────────────
function Popover({ story, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const h=(e)=>{if(ref.current&&!ref.current.contains(e.target))onClose()};
    setTimeout(()=>document.addEventListener("mousedown",h),10);
    return()=>document.removeEventListener("mousedown",h);
  },[onClose]);
  const sc = stColor(story);
  const isOver = story.status === "done" ? story.wasLate : story.isOverrunning;
  const durRatio = story.actualDur ? story.actualDur / story.plannedDur : null;
  return (
    <div ref={ref} style={{position:"fixed",right:20,top:80,width:320,background:"#111827",border:"1px solid #1e293b",borderRadius:8,zIndex:1000,boxShadow:"0 20px 60px rgba(0,0,0,0.6)",fontFamily:"'JetBrains Mono',monospace",animation:"popIn 0.2s ease"}}>
      <style>{`@keyframes popIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}`}</style>
      <div style={{padding:"12px 14px 10px",borderBottom:"1px solid #1e293b"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:10,color:sc}}>●</span>
          <span style={{fontSize:13,fontWeight:600,color:"#f8fafc",fontFamily:"'DM Sans',sans-serif",flex:1}}>{story.label}</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#4a5568",fontSize:14,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.5}}>{story.desc}</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr"}}>
        {[
          {l:"Status",v:story.status.toUpperCase(),c:sc},
          {l:"Story Points",v:`${story.sp} SP`,c:"#e2e8f0"},
          {l:"Planned",v:fmt(story.plannedDur),c:"#64748b"},
          {l:"Actual",v:story.actualDur ? fmt(story.actualDur) : story.status==="running" ? `${fmt(story.barWidth)} so far` : "—",c:isOver?"#f59e0b":"#e2e8f0"},
          {l:"Progress",v:`${Math.round(story.progress)}%`,c:"#a78bfa"},
          {l:"Cost",v:`$${story.cost.toFixed(2)}`,c:"#f59e0b"},
          {l:"Displaced",v:story.displacement>0.5?`+${fmt(story.displacement)}`:"None",c:story.displacement>0.5?"#f59e0b":"#22c55e"},
          {l:"Over",v:durRatio?`${durRatio.toFixed(2)}×`:story.isOverrunning?"active":"—",c:isOver?"#ef4444":"#64748b"},
        ].map((it,i)=>(
          <div key={i} style={{padding:"6px 14px",borderBottom:i<6?"1px solid #1a2236":"none",borderRight:i%2===0?"1px solid #1a2236":"none"}}>
            <div style={{fontSize:7,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2}}>{it.l}</div>
            <div style={{fontSize:11,fontWeight:600,color:it.c}}>{it.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── StoryBar ──────────────────────────────────────────────────────
function StoryBar({ story, totalTime, onSelect }) {
  const toP = v => (v / totalTime) * 100;
  const sc = stColor(story);
  const bg = barGradient(story);
  const shadow = story.isOverrunning ? "0 0 18px rgba(239,68,68,0.35)"
    : story.status === "running" ? "0 0 10px rgba(167,139,250,0.22)"
    : "none";

  // Planned ghost geometry (ALWAYS at the planned position)
  const pL = toP(story.plannedStart);
  const pW = toP(story.plannedDur);

  // Actual bar geometry — this is what moves in real-time
  const aL = toP(story.actualStart);
  const aW = toP(story.barWidth);

  // Fill width inside the actual bar (progress%)
  const fillPct = story.progress;

  // Show ghost only when actually displaced from plan OR stretched past plan
  const showGhost = (story.displacement > 0.3) ||
                    (story.status !== "queued" && story.barWidth > story.plannedDur + 0.1);

  return (
    <div style={{position:"relative",height:30,marginBottom:1}}>
      {/* Planned ghost: the "was supposed to be here" outline */}
      {showGhost && (
        <div style={{
          position:"absolute",
          left:`${pL}%`, width:`${pW}%`,
          top:4, height:22, borderRadius:4,
          border:"1px dashed #33415588",
          pointerEvents:"none", zIndex:0,
        }}/>
      )}

      {/* Displacement connector line (arrow from planned start → actual start) */}
      {showGhost && story.displacement > 0.5 && story.status !== "queued" && (
        <div style={{
          position:"absolute",
          left:`${pL + pW}%`, width:`${aL - (pL + pW)}%`,
          top:14, height:2,
          background:"linear-gradient(90deg, #33415566, #f59e0b88)",
          pointerEvents:"none", zIndex:0,
        }}>
          <div style={{position:"absolute",right:-4,top:-3,width:0,height:0,borderTop:"4px solid transparent",borderBottom:"4px solid transparent",borderLeft:"6px solid #f59e0b"}}/>
        </div>
      )}

      {/* The LIVE actual bar — moves in real-time */}
      <div onClick={(e)=>{e.stopPropagation();onSelect(story)}} style={{
        position:"absolute",
        left:`${aL}%`, width:`${Math.max(aW,0.2)}%`,
        top:3, height:24, borderRadius:4,
        background:"#131c2e",
        border:`1px solid ${sc}30`,
        overflow:"hidden",
        boxShadow:shadow,
        cursor:"pointer",
        zIndex:1,
        transition:"border-color 0.3s, box-shadow 0.3s", // NO transition on left/width — must be instant
      }}>
        <div style={{
          height:"100%",
          width:`${fillPct}%`,
          background:bg,
          borderRadius:3,
          transition:"background 0.4s",
        }}/>
        <div style={{
          position:"absolute",top:0,left:8,right:4,height:"100%",
          display:"flex",alignItems:"center",justifyContent:"space-between",
          fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"#e2e8f0",pointerEvents:"none",gap:4,
        }}>
          <span style={{opacity:0.9,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",display:"flex",alignItems:"center",gap:4}}>
            {story.label}
            {story.isOverrunning&&<span style={{fontSize:9,color:"#fecaca",animation:"pulse 1s infinite"}}>⚠</span>}
          </span>
          <span style={{opacity:0.55,flexShrink:0,fontSize:9}}>
            {story.status!=="queued"&&<>{fmt(story.barWidth)} · ${story.cost.toFixed(2)}</>}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── AggBar ────────────────────────────────────────────────────────
function AggBar({ stories, color, totalTime }) {
  if(!stories.length) return null;
  const toP = v => (v / totalTime) * 100;
  const as0 = Math.min(...stories.map(s => s.actualStart));
  const as1 = Math.max(...stories.map(s => s.actualStart + s.barWidth));
  const ps0 = Math.min(...stories.map(s => s.plannedStart));
  const ps1 = Math.max(...stories.map(s => s.plannedEnd));
  const pr = stories.reduce((a,s) => a + s.progress, 0) / stories.length;
  const co = stories.reduce((a,s) => a + s.cost, 0);
  const anyStress = stories.some(s => s.isOverrunning);
  const anyLate = stories.some(s => s.wasLate);
  const disp = as1 - ps1;
  const bc = anyStress ? "#ef4444" : (anyLate || disp > 1 ? "#f59e0b" : color);

  return (
    <div style={{position:"relative",height:24,marginBottom:1}}>
      {(disp > 1 || anyStress) && (
        <div style={{position:"absolute",left:`${toP(ps0)}%`,width:`${toP(ps1-ps0)}%`,top:3,height:18,borderRadius:3,border:"1px dashed #ffffff10",pointerEvents:"none"}}/>
      )}
      <div style={{
        position:"absolute",
        left:`${toP(as0)}%`,
        width:`${Math.max(toP(as1-as0),0.5)}%`,
        top:2, height:20, borderRadius:3,
        background:"#0c1322",
        border:`1px solid ${bc}25`,
        overflow:"hidden",
        transition:"border-color 0.3s",
      }}>
        <div style={{height:"100%",width:`${pr}%`,background:`linear-gradient(90deg,${bc}40,${bc}18)`,borderRadius:2,transition:"background 0.3s"}}/>
        <div style={{position:"absolute",top:0,right:8,height:"100%",display:"flex",alignItems:"center",gap:8,fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:bc,opacity:0.75}}>
          {disp > 1 && <span style={{color:"#f59e0b",fontSize:8}}>+{fmt(disp)}</span>}
          <span>{Math.round(pr)}% · ${co.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── TreeNode ──────────────────────────────────────────────────────
function TreeNode({ node, depth, exp, toggle, sim, onSel }) {
  const { stories:sm, totalTime } = sim;
  const isW = node.type === "wave", isE = node.type === "epic", isV = node.type === "version";
  const hasCh = node.children && node.children.length > 0;
  const open = exp[node.id];
  const indent = depth * 20;

  let ns = [];
  if (isW) ns = node.storyIds.map(id => sm[id]).filter(Boolean);
  else if (isE) ns = node.children.flatMap(w => w.storyIds.map(id => sm[id]).filter(Boolean));
  else if (isV) ns = sim.allStories;

  const color = TC[node.type];

  return (
    <>
      <div style={{display:"flex",alignItems:"stretch",minHeight:isW?34:38,borderBottom:"1px solid #111827"}}>
        <div style={{width:340,minWidth:340,display:"flex",alignItems:"center",paddingLeft:14+indent,paddingRight:12,borderRight:"1px solid #151d2e",cursor:hasCh?"pointer":"default",userSelect:"none",background:depth===0?"#080d18":"transparent"}} onClick={()=>hasCh&&toggle(node.id)}>
          {hasCh?(<span style={{display:"inline-flex",width:18,height:18,alignItems:"center",justifyContent:"center",fontSize:10,color:"#4a5568",marginRight:6,flexShrink:0,transition:"transform 0.2s",transform:open?"rotate(90deg)":"rotate(0deg)"}}>▶</span>):<span style={{width:24,flexShrink:0}}/>}
          <span style={{color,fontSize:10,marginRight:8,flexShrink:0}}>{TI[node.type]}</span>
          <span style={{fontSize:isV?14:isE?13:12,fontWeight:isV?700:isE?600:500,color:"#e2e8f0",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{node.label}</span>
          {isW&&<span style={{marginLeft:8,fontSize:8,fontFamily:"'JetBrains Mono',monospace",padding:"1px 5px",borderRadius:3,background:"#8b5cf612",color:"#8b5cf6",border:"1px solid #8b5cf625",flexShrink:0}}>{ns.length}P</span>}
        </div>
        <div style={{flex:1,position:"relative",padding:"3px 0"}}><AggBar stories={ns} color={color} totalTime={totalTime}/></div>
      </div>
      {isW && open && ns.map(s => {
        const sc = stColor(s);
        return (
          <div key={s.id} style={{display:"flex",alignItems:"stretch",minHeight:34,borderBottom:"1px solid #0e1525"}}>
            <div style={{width:340,minWidth:340,display:"flex",alignItems:"center",paddingLeft:14+(depth+1)*20,paddingRight:12,borderRight:"1px solid #151d2e"}}>
              <span style={{width:24,flexShrink:0}}/>
              <span style={{color:sc,fontSize:10,marginRight:8,flexShrink:0,transition:"color 0.3s"}}>●</span>
              <span style={{fontSize:11,fontWeight:400,color:"#cbd5e1",fontFamily:"'JetBrains Mono',monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.label}</span>
              {s.isOverrunning&&<span style={{marginLeft:5,fontSize:8,color:"#ef4444",animation:"pulse 1s infinite"}}>⚠</span>}
              {s.tool&&<span style={{marginLeft:6,fontSize:7,fontFamily:"'JetBrains Mono',monospace",padding:"1px 4px",borderRadius:3,background:"#7c3aed18",color:"#a78bfa",border:"1px solid #7c3aed30",flexShrink:0}}>{s.tool}</span>}
              <span style={{marginLeft:4,fontSize:7,fontFamily:"'JetBrains Mono',monospace",padding:"1px 4px",borderRadius:3,background:"#1e293b",color:"#64748b",border:"1px solid #2d3a4f",flexShrink:0}}>{s.sp}SP</span>
              {s.displacement > 0.5 && <span style={{marginLeft:4,fontSize:7,fontFamily:"'JetBrains Mono',monospace",padding:"1px 4px",borderRadius:3,background:"#f59e0b10",color:"#f59e0b",border:"1px solid #f59e0b25",flexShrink:0}}>+{Math.round(s.displacement)}s</span>}
              <span style={{marginLeft:"auto",paddingLeft:6,fontSize:8,fontFamily:"'JetBrains Mono',monospace",padding:"2px 6px",borderRadius:3,background:`${sc}10`,color:sc,border:`1px solid ${sc}25`,textTransform:"uppercase",letterSpacing:"0.05em",flexShrink:0,transition:"all 0.3s"}}>{s.status}</span>
            </div>
            <div style={{flex:1,position:"relative",padding:"2px 0"}}><StoryBar story={s} totalTime={totalTime} onSelect={onSel}/></div>
          </div>
        );
      })}
      {hasCh && open && node.children.map(ch => (
        <TreeNode key={ch.id} node={ch} depth={depth+1} exp={exp} toggle={toggle} sim={sim} onSel={onSel}/>
      ))}
    </>
  );
}

// ─── TimeRuler ─────────────────────────────────────────────────────
function TimeRuler({ t, totalTime }) {
  const step = totalTime > 180 ? 20 : totalTime > 120 ? 15 : 10;
  const marks = [];
  for (let i = 0; i <= totalTime + step; i += step) marks.push(i);
  const toP = v => (v / totalTime) * 100;
  return (
    <div style={{display:"flex",alignItems:"stretch",height:28,borderBottom:"2px solid #151d2e",background:"#060a14"}}>
      <div style={{width:340,minWidth:340,borderRight:"1px solid #151d2e",display:"flex",alignItems:"center",paddingLeft:16,fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:"#3e4a5c",textTransform:"uppercase",letterSpacing:"0.1em"}}>Timeline</div>
      <div style={{flex:1,position:"relative"}}>
        {marks.filter(m => m <= totalTime).map(m => (
          <div key={m} style={{position:"absolute",left:`${toP(m)}%`,top:0,bottom:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
            <span style={{fontSize:7,fontFamily:"'JetBrains Mono',monospace",color:m%(step*3)===0?"#64748b":"#2d3a4f",marginBottom:2}}>{fmt(m)}</span>
            <div style={{width:1,height:m%(step*3)===0?8:4,background:m%(step*3)===0?"#334155":"#1a2236"}}/>
          </div>
        ))}
        <div style={{position:"absolute",left:`${Math.min(toP(t),100)}%`,top:0,bottom:-2,width:2,background:"#f59e0b",borderRadius:1,boxShadow:"0 0 8px #f59e0b66",zIndex:10}}>
          <div style={{position:"absolute",top:-2,left:-5,width:12,height:6,background:"#f59e0b",borderRadius:"2px 2px 0 0"}}/>
        </div>
      </div>
    </div>
  );
}

function Scrubber({ t, totalTime, onSeek }) {
  const ref = useRef(null); const drag = useRef(false);
  const calc = useCallback(e => { const r = ref.current.getBoundingClientRect(); onSeek(Math.max(0, Math.min(totalTime, ((e.clientX - r.left) / r.width) * totalTime))); }, [onSeek, totalTime]);
  useEffect(() => { const mv = e => { if (drag.current) calc(e) }; const up = () => { drag.current = false }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up) } }, [calc]);
  const toP = v => Math.min((v / totalTime) * 100, 100);
  return (
    <div ref={ref} onMouseDown={e => { drag.current = true; calc(e) }} style={{height:8,background:"#0c1322",cursor:"pointer",position:"relative",borderTop:"1px solid #151d2e"}}>
      <div style={{height:"100%",width:`${toP(t)}%`,background:"linear-gradient(90deg,#f59e0b33,#f59e0b77)"}}/>
      <div style={{position:"absolute",top:-4,left:`${toP(t)}%`,width:14,height:14,borderRadius:"50%",background:"#f59e0b",border:"2px solid #070c16",transform:"translateX(-7px)",boxShadow:"0 0 10px #f59e0b66"}}/>
    </div>
  );
}

function GridLines({ t, totalTime }) {
  const step = totalTime > 180 ? 20 : totalTime > 120 ? 15 : 10;
  const lines = []; for (let i = 0; i <= totalTime + step; i += step) lines.push(i);
  const toP = v => (v / totalTime) * 100;
  return (
    <div style={{position:"absolute",top:0,left:340,right:0,bottom:0,pointerEvents:"none",zIndex:0}}>
      {lines.filter(i => i <= totalTime).map(i => <div key={i} style={{position:"absolute",left:`${toP(i)}%`,top:0,bottom:0,width:1,background:i%(step*3)===0?"#151d2e66":"#0e152511"}}/>)}
      <div style={{position:"absolute",left:`${Math.min(toP(t),100)}%`,top:0,bottom:0,width:1,background:"#f59e0b1a",zIndex:1}}/>
    </div>
  );
}

function buildTree() {
  return { id:"v1", type:"version", label:"Agent Orchestrator v1.0",
    children: EPIC_DEFS.map(e => ({ id:e.id, type:"epic", label:e.label,
      children: e.waves.map(w => ({ id:w.id, type:"wave", label:w.label, storyIds: w.stories.map(s => s.id) }))
    }))
  };
}

// ─── Main ──────────────────────────────────────────────────────────
export default function App() {
  const tree = useMemo(buildTree, []);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [exp, setExp] = useState(() => { const e={v1:true}; EPIC_DEFS.forEach(ep=>{e[ep.id]=true;ep.waves.forEach(w=>{e[w.id]=true})}); return e; });
  const [sel, setSel] = useState(null);
  const animRef = useRef(null); const lastRef = useRef(null);

  const sim = useMemo(() => simulate(t), [t]);

  // 120 real seconds ≈ full planned timeline + some buffer. Scale once.
  const SIM_REAL = 120;
  const initialPlanned = useMemo(() => simulate(0).totalPlanned, []);
  const simScale = initialPlanned / SIM_REAL;

  useEffect(() => {
    if (!playing) { lastRef.current = null; return; }
    const tick = now => {
      if (lastRef.current !== null) {
        const dtReal = (now - lastRef.current) / 1000 * speed;
        const dtSim = dtReal * simScale;
        setT(prev => {
          const n = prev + dtSim;
          const s = simulate(n);
          if (s.allDone) { setPlaying(false); return s.totalActual; }
          return n;
        });
      }
      lastRef.current = now;
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animRef.current); lastRef.current = null; };
  }, [playing, speed, simScale]);

  const toggle = id => setExp(p => ({...p, [id]:!p[id]}));
  const done = sim.allStories.filter(s => s.status === "done").length;
  const running = sim.allStories.filter(s => s.status === "running").length;
  const queued = sim.allStories.filter(s => s.status === "queued").length;
  const stressed = sim.allStories.filter(s => s.isOverrunning).length;
  const totalCost = sim.allStories.reduce((a,s) => a + s.cost, 0);
  const overallProg = sim.allStories.reduce((a,s) => a + s.progress, 0) / sim.allStories.length;
  const totalDisp = sim.totalActual - sim.totalPlanned;

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:"#070c16",color:"#e2e8f0",minHeight:"100vh",overflow:"auto"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#070c16}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:3px}button:focus{outline:none}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>

      <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 20px",background:"linear-gradient(135deg,#080d18,#0f172a)",borderBottom:"1px solid #151d2e",flexWrap:"wrap"}}>
        <button onClick={playing?()=>setPlaying(false):()=>{if(sim.allDone)setT(0);setPlaying(true)}} style={{width:48,height:48,borderRadius:"50%",border:"2px solid #f59e0b55",background:playing?"#f59e0b18":"#f59e0b0a",color:"#f59e0b",fontSize:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:playing?"0 0 20px #f59e0b33":"none"}}>{playing?"⏸":"▶"}</button>
        <button onClick={()=>{setPlaying(false);setT(0);setSel(null)}} style={{width:36,height:36,borderRadius:"50%",border:"1px solid #1e293b",background:"#131c2e",color:"#64748b",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
        <div style={{display:"flex",gap:3}}>
          {[1,2,4,8].map(s => (<button key={s} onClick={()=>setSpeed(s)} style={{padding:"4px 10px",borderRadius:4,border:"1px solid",borderColor:speed===s?"#f59e0b44":"#151d2e",background:speed===s?"#f59e0b12":"transparent",color:speed===s?"#f59e0b":"#3e4a5c",fontSize:10,fontFamily:"'JetBrains Mono',monospace",cursor:"pointer"}}>{s}×</button>))}
        </div>
        <div style={{padding:"6px 16px",borderRadius:6,background:"#131c2e",border:"1px solid #1e293b",fontFamily:"'JetBrains Mono',monospace",fontSize:20,fontWeight:700,color:"#f8fafc",minWidth:80,textAlign:"center",fontVariantNumeric:"tabular-nums"}}>{fmt(t)}</div>
        <div style={{position:"relative",width:48,height:48,flexShrink:0}}>
          <svg width="48" height="48" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="#151d2e" strokeWidth="3"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke={overallProg>=99.9?"#22c55e":stressed>0?"#ef4444":"#a78bfa"} strokeWidth="3" strokeDasharray={`${(overallProg/100)*125.7} 125.7`} strokeLinecap="round" transform="rotate(-90 24 24)"/>
          </svg>
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#e2e8f0"}}>{Math.round(overallProg)}%</div>
        </div>
        <div style={{display:"flex",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
          {[{l:"Done",v:done,c:"#22c55e"},{l:"Live",v:running,c:"#a78bfa"},{l:"Stress",v:stressed,c:"#ef4444"},{l:"Queue",v:queued,c:"#3e4a5c"}].map(s => (
            <div key={s.l} style={{textAlign:"center",padding:"4px 8px",borderRadius:5,background:`${s.c}08`,border:`1px solid ${s.c}15`,minWidth:40}}>
              <div style={{fontSize:16,fontWeight:700,color:s.c,fontFamily:"'JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{s.v}</div>
              <div style={{fontSize:7,color:"#3e4a5c",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'JetBrains Mono',monospace"}}>{s.l}</div>
            </div>
          ))}
          <div style={{textAlign:"center",padding:"4px 8px",borderRadius:5,background:"#f59e0b08",border:"1px solid #f59e0b15",minWidth:55}}>
            <div style={{fontSize:16,fontWeight:700,color:"#f59e0b",fontFamily:"'JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>${totalCost.toFixed(2)}</div>
            <div style={{fontSize:7,color:"#3e4a5c",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'JetBrains Mono',monospace"}}>Cost</div>
          </div>
          {totalDisp > 0.5 && (
            <div style={{textAlign:"center",padding:"4px 8px",borderRadius:5,background:"#ef444408",border:"1px solid #ef444415",minWidth:55}}>
              <div style={{fontSize:16,fontWeight:700,color:"#ef4444",fontFamily:"'JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>+{fmt(totalDisp)}</div>
              <div style={{fontSize:7,color:"#3e4a5c",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'JetBrains Mono',monospace"}}>Slip</div>
            </div>
          )}
        </div>
      </div>

      <Scrubber t={t} totalTime={sim.totalTime} onSeek={v => { setT(v); setPlaying(false) }}/>
      <div style={{position:"relative"}}>
        <TimeRuler t={t} totalTime={sim.totalTime}/>
        <div style={{position:"relative",minWidth:900}}>
          <GridLines t={t} totalTime={sim.totalTime}/>
          <TreeNode node={tree} depth={0} exp={exp} toggle={toggle} sim={sim} onSel={setSel}/>
        </div>
      </div>

      <div style={{display:"flex",gap:12,padding:"10px 20px",borderTop:"1px solid #151d2e",background:"#060a14",fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:"#2d3a4f",flexWrap:"wrap"}}>
        <span><span style={{color:"#a78bfa"}}>━</span> In progress</span>
        <span><span style={{color:"#22c55e"}}>━</span> Done on time</span>
        <span><span style={{color:"#ef4444"}}>━</span> Overrunning NOW</span>
        <span><span style={{color:"#f59e0b"}}>━</span> Done late</span>
        <span><span style={{color:"#334155"}}>┅</span> Planned position</span>
        <span style={{marginLeft:"auto"}}>Downstream stories reposition live — projected end = now, until the blocker finishes</span>
      </div>

      {sel && <Popover story={sel} onClose={()=>setSel(null)}/>}
    </div>
  );
}
