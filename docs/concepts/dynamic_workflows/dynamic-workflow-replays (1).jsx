import { useState } from "react";

// ————————————————————————————————————————————————————————————————
// Palette — speaks the Pipeline v2.5 console dialect
// ————————————————————————————————————————————————————————————————
const C = {
  bg: "#0B0D10",
  panel: "#11151A",
  panel2: "#161B22",
  border: "#232A33",
  border2: "#2E3742",
  fg: "#E8ECF0",
  dim: "#8A94A0",
  faint: "#5A6470",
  cyan: "#4FD8E8",
  amber: "#E8B44F",
  purple: "#A78BFA",
  green: "#4ADE80",
  red: "#F87171",
  blue: "#60A5FA",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// ————————————————————————————————————————————————————————————————
// Atoms
// ————————————————————————————————————————————————————————————————
const Eyebrow = ({ children, color = C.faint }) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 9,
      letterSpacing: "0.26em",
      textTransform: "uppercase",
      color,
      marginBottom: 8,
    }}
  >
    {children}
  </div>
);

const Metric = ({ label, value, color = C.fg, sub }) => (
  <div style={{ minWidth: 0 }}>
    <Eyebrow>{label}</Eyebrow>
    <div
      style={{
        fontFamily: MONO,
        fontSize: 22,
        fontWeight: 300,
        color,
        letterSpacing: "-0.01em",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </div>
    {sub && (
      <div style={{ fontFamily: MONO, fontSize: 10, color: C.faint, marginTop: 4 }}>{sub}</div>
    )}
  </div>
);

const Chip = ({ children, color }) => (
  <span
    style={{
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color,
      border: `1px solid ${color}44`,
      background: `${color}12`,
      padding: "4px 10px",
      borderRadius: 2,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

const Panel = ({ children, style }) => (
  <div style={{ border: `1px solid ${C.border}`, background: C.panel, ...style }}>{children}</div>
);

const Code = ({ children }) => (
  <pre
    style={{
      fontFamily: MONO,
      fontSize: 11.5,
      lineHeight: 1.7,
      color: C.dim,
      background: C.bg,
      border: `1px solid ${C.border}`,
      padding: "14px 16px",
      overflowX: "auto",
      margin: 0,
    }}
  >
    {children}
  </pre>
);

const K = ({ children }) => <span style={{ color: C.purple }}>{children}</span>; // keyword
const F = ({ children }) => <span style={{ color: C.cyan }}>{children}</span>; // fn
const S = ({ children }) => <span style={{ color: C.amber }}>{children}</span>; // string
const Cm = ({ children }) => <span style={{ color: C.faint }}>{children}</span>; // comment

// ————————————————————————————————————————————————————————————————
// Timeline ribbon: rows of bars on a shared minute scale
// ————————————————————————————————————————————————————————————————
function Ribbon({ title, total, rows, scaleMax, accent }) {
  const W = 100; // percent space
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: accent,
          }}
        >
          {title}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 13, color: C.fg }}>{total}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 9,
                letterSpacing: "0.08em",
                color: C.faint,
                width: 118,
                flexShrink: 0,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.label}
            </span>
            <div style={{ flex: 1, height: 14, position: "relative", background: `${C.border}55` }}>
              {r.bars.map((b, j) => (
                <div
                  key={j}
                  title={b.tip}
                  style={{
                    position: "absolute",
                    left: `${(b.start / scaleMax) * W}%`,
                    width: `${Math.max((b.len / scaleMax) * W, 0.6)}%`,
                    top: 2,
                    bottom: 2,
                    background: b.color,
                    opacity: b.ghost ? 0.28 : 0.85,
                    outline: b.ghost ? `1px dashed ${b.color}` : "none",
                  }}
                />
              ))}
            </div>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: r.timeColor || C.dim,
                width: 52,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {r.time}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// SVG DAG helpers
// ————————————————————————————————————————————————————————————————
function Node({ x, y, w = 118, h = 34, label, sub, color = C.dim, fill, dashed }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={fill || C.panel2}
        stroke={color}
        strokeWidth={1}
        strokeDasharray={dashed ? "4 3" : "none"}
      />
      <text
        x={x + w / 2}
        y={y + (sub ? 15 : 21)}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={10}
        fill={C.fg}
      >
        {label}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + 27}
          textAnchor="middle"
          fontFamily={MONO}
          fontSize={8}
          letterSpacing="0.08em"
          fill={color}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function Edge({ x1, y1, x2, y2, color = C.faint, label, dashed }) {
  const mx = (x1 + x2) / 2;
  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeDasharray={dashed ? "4 3" : "none"}
        markerEnd="url(#arr)"
      />
      {label && (
        <text
          x={mx}
          y={(y1 + y2) / 2 - 6}
          textAnchor="middle"
          fontFamily={MONO}
          fontSize={8}
          letterSpacing="0.1em"
          fill={color}
        >
          {label}
        </text>
      )}
    </g>
  );
}

const Defs = () => (
  <defs>
    <marker id="arr" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
      <path d="M 0 0 L 8 4 L 0 8 z" fill={C.faint} />
    </marker>
  </defs>
);

// ————————————————————————————————————————————————————————————————
// Shared comparison shell for each workflow tab
// ————————————————————————————————————————————————————————————————
function CompareGrid({ staticSide, dynamicSide }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
        gap: 1,
        background: C.border,
        border: `1px solid ${C.border}`,
        marginBottom: 22,
      }}
    >
      <div style={{ background: C.panel, padding: "18px 20px" }}>
        <Eyebrow color={C.red}>static pipeline · what actually ran</Eyebrow>
        {staticSide}
      </div>
      <div style={{ background: C.panel, padding: "18px 20px" }}>
        <Eyebrow color={C.green}>dynamic workflow · projected replay</Eyebrow>
        {dynamicSide}
      </div>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// WF-1 — Readiness Cascade
// ————————————————————————————————————————————————————————————————
function WF1() {
  const scale = 50;
  return (
    <div>
      <p style={{ color: C.dim, fontSize: 13.5, lineHeight: 1.7, maxWidth: 760, margin: "0 0 20px" }}>
        In the real run, E4 (Assembly) sat at 0% for the entire session because wave walls are hard
        barriers: PW2 cannot start until every story in PW1 is <em>fully done</em> — so the whole
        plan inherited E3's 26-minute fix stall. A workflow script holds each story's readiness as a
        variable and releases dependents the moment their <em>required tier</em> is reached:
        E4's feature-registration story only needs E2/E3 contracts (types + signatures), which were
        stable after review at roughly minute 14.
      </p>

      <CompareGrid
        staticSide={
          <svg viewBox="0 0 520 190" style={{ width: "100%", height: "auto" }}>
            <Defs />
            {/* wave walls */}
            <line x1={165} y1={8} x2={165} y2={182} stroke={C.red} strokeWidth={1} strokeDasharray="3 4" opacity={0.6} />
            <line x1={345} y1={8} x2={345} y2={182} stroke={C.red} strokeWidth={1} strokeDasharray="3 4" opacity={0.6} />
            <text x={165} y={188} textAnchor="middle" fontFamily={MONO} fontSize={8} fill={C.red} letterSpacing="0.12em">WAVE WALL</text>
            <text x={345} y={188} textAnchor="middle" fontFamily={MONO} fontSize={8} fill={C.red} letterSpacing="0.12em">WAVE WALL</text>
            <Node x={20} y={75} label="E1 types" sub="PW0 · 3m46s" color={C.green} />
            <Node x={195} y={28} label="E2 render ×3" sub="PW1 · 17m10s" color={C.green} />
            <Node x={195} y={120} label="E3 logic ×4" sub="PW1 · 26m04s" color={C.red} />
            <Node x={375} y={75} label="E4 assembly ×2" sub="PW2 · blocked" color={C.faint} dashed />
            <Edge x1={138} y1={92} x2={195} y2={45} />
            <Edge x1={138} y1={92} x2={195} y2={137} />
            <Edge x1={313} y1={45} x2={375} y2={92} color={C.red} label="fully-done" />
            <Edge x1={313} y1={137} x2={375} y2={92} color={C.red} label="fully-done" />
          </svg>
        }
        dynamicSide={
          <svg viewBox="0 0 520 190" style={{ width: "100%", height: "auto" }}>
            <Defs />
            <Node x={14} y={75} label="E1 types" sub="3m46s" color={C.green} />
            <Node x={166} y={20} label="E2 render ×3" sub="review ✓ @14m" color={C.green} />
            <Node x={166} y={130} label="E3 logic ×4" sub="contract ✓ @13m" color={C.amber} />
            <Node x={344} y={20} label="E4 registration" sub="starts @14m" color={C.purple} />
            <Node x={344} y={75} label="E4 HUD" sub="starts @4m (types only)" color={C.purple} />
            <Node x={344} y={130} label="verify gate" sub="tests-passing req." color={C.cyan} />
            <Edge x1={132} y1={92} x2={166} y2={37} />
            <Edge x1={132} y1={92} x2={166} y2={147} />
            <Edge x1={132} y1={92} x2={344} y2={92} color={C.purple} label="contract-stable" />
            <Edge x1={284} y1={37} x2={344} y2={37} color={C.purple} label="contract-stable" />
            <Edge x1={284} y1={147} x2={344} y2={147} color={C.cyan} label="tests-passing" dashed />
          </svg>
        }
      />

      <Panel style={{ padding: "18px 20px", marginBottom: 22 }}>
        <Eyebrow>shared clock · minutes 0–50</Eyebrow>
        <Ribbon
          title="static · actual"
          total="47m 01s"
          scaleMax={scale}
          accent={C.red}
          rows={[
            { label: "E1 foundation", time: "3m46", bars: [{ start: 0, len: 3.8, color: C.green }] },
            { label: "E2 rendering", time: "17m10", bars: [{ start: 4, len: 17.2, color: C.blue }] },
            { label: "E3 logic+fix", time: "26m04", timeColor: C.red, bars: [{ start: 4, len: 26.1, color: C.red }] },
            { label: "E4 assembly", time: "0s", timeColor: C.faint, bars: [{ start: 30.2, len: 16, color: C.faint, ghost: true, tip: "never started — still draft at session end" }] },
          ]}
        />
        <Ribbon
          title="dynamic · projected"
          total="≈26m"
          scaleMax={scale}
          accent={C.green}
          rows={[
            { label: "E1 foundation", time: "3m46", bars: [{ start: 0, len: 3.8, color: C.green }] },
            { label: "E2 rendering", time: "17m10", bars: [{ start: 4, len: 17.2, color: C.blue }] },
            { label: "E3 logic+fix", time: "26m04", bars: [{ start: 4, len: 22, color: C.red }] },
            {
              label: "E4 HUD",
              time: "@4m",
              timeColor: C.purple,
              bars: [{ start: 4, len: 6, color: C.purple, tip: "needs only E1 types — contract-stable" }],
            },
            {
              label: "E4 registration",
              time: "@14m",
              timeColor: C.purple,
              bars: [{ start: 14, len: 9, color: C.purple, tip: "starts on E2/E3 contract-stable" }],
            },
            { label: "final verify", time: "@24m", timeColor: C.cyan, bars: [{ start: 24, len: 2.4, color: C.cyan }] },
          ]}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <Chip color={C.green}>wall time 47m → ≈26m</Chip>
          <Chip color={C.purple}>E4 idle 47m → 0m</Chip>
          <Chip color={C.cyan}>plan ships despite E3 stall</Chip>
        </div>
      </Panel>

      <Eyebrow>what the script holds — the wave wall becomes a variable</Eyebrow>
      <Code>
        <K>const</K> readiness = {"{}"}; <Cm>// storyId → 'contract-stable' | 'tests-passing' | 'fully-done'</Cm>{"\n"}
        <K>const</K> TIERS = [<S>'contract-stable'</S>, <S>'tests-passing'</S>, <S>'fully-done'</S>];{"\n\n"}
        <K>async function</K> <F>runStory</F>(story) {"{"}{"\n"}
        {"  "}<K>await</K> <F>spawnAgent</F>({"{"} role: <S>'dev'</S>, cwd: story.worktree {"}"});{"\n"}
        {"  "}<K>if</K> (<K>await</K> <F>spawnAgent</F>({"{"} role: <S>'reviewer'</S> {"}"}).passed) <F>setTier</F>(story, <S>'contract-stable'</S>);{"\n"}
        {"  "}<K>if</K> (<K>await</K> <F>spawnAgent</F>({"{"} role: <S>'qa'</S> {"}"}).green) <F>setTier</F>(story, <S>'tests-passing'</S>);{"\n"}
        {"}"}{"\n\n"}
        <K>function</K> <F>setTier</F>(story, tier) {"{"}{"\n"}
        {"  "}readiness[story.id] = tier;{"\n"}
        {"  "}<Cm>// dependents launch the instant their edge requirement is met —</Cm>{"\n"}
        {"  "}<Cm>// no wave wall, no waiting on the slowest sibling</Cm>{"\n"}
        {"  "}<K>for</K> (<K>const</K> dep <K>of</K> <F>dependentsOf</F>(story, tier)) <F>runStory</F>(dep);{"\n"}
        {"}"}
      </Code>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// WF-2 — Fix Swarm
// ————————————————————————————————————————————————————————————————
function WF2() {
  return (
    <div>
      <p style={{ color: C.dim, fontSize: 13.5, lineHeight: 1.7, maxWidth: 760, margin: "0 0 20px" }}>
        E3 burned 26m04s against a 3m budget in a <em>serial</em> fix loop: one fixer, one
        hypothesis at a time, each round paying a full compile cycle. A workflow turns a red gate
        into a fan-out: independent fixers attack the failure from distinct hypotheses in scratch
        worktrees, a refuter tries to break each candidate, and only a converged, adversarially
        survived fix merges. This is also the answer to the silent auto-resolver problem — no fix
        lands without an agent having actively tried to refute it.
      </p>

      <CompareGrid
        staticSide={
          <svg viewBox="0 0 520 180" style={{ width: "100%", height: "auto" }}>
            <Defs />
            <Node x={16} y={70} label="gate: RED" sub="collision tests fail" color={C.red} />
            <Node x={190} y={70} label="fixer #1" sub="single hypothesis" color={C.amber} />
            <Node x={364} y={70} label="compile + test" sub="full cycle each loop" color={C.dim} />
            <Edge x1={134} y1={87} x2={190} y2={87} />
            <Edge x1={308} y1={87} x2={364} y2={87} />
            {/* loop back */}
            <path d="M 423 104 C 423 150, 75 150, 75 104" fill="none" stroke={C.red} strokeWidth={1.2} strokeDasharray="4 3" markerEnd="url(#arr)" />
            <text x={250} y={158} textAnchor="middle" fontFamily={MONO} fontSize={9} fill={C.red} letterSpacing="0.12em">
              SERIAL RETRY ×N — 26m04s / 3m BUDGET
            </text>
          </svg>
        }
        dynamicSide={
          <svg viewBox="0 0 520 230" style={{ width: "100%", height: "auto" }}>
            <Defs />
            <Node x={10} y={96} w={104} label="gate: RED" color={C.red} />
            <Node x={150} y={14} w={130} label="fixer · reducer" sub="state mutation bug?" color={C.amber} />
            <Node x={150} y={96} w={130} label="fixer · collision" sub="pixel math bug?" color={C.amber} />
            <Node x={150} y={178} w={130} label="fixer · tests" sub="wrong expectation?" color={C.amber} />
            <Node x={312} y={14} w={92} label="refuter" color={C.cyan} />
            <Node x={312} y={96} w={92} label="refuter" color={C.cyan} />
            <Node x={312} y={178} w={92} label="refuter" color={C.cyan} />
            <Node x={432} y={96} w={80} label="vote ✓" sub="merge 1" color={C.green} />
            <Edge x1={114} y1={113} x2={150} y2={31} />
            <Edge x1={114} y1={113} x2={150} y2={113} />
            <Edge x1={114} y1={113} x2={150} y2={195} />
            <Edge x1={280} y1={31} x2={312} y2={31} />
            <Edge x1={280} y1={113} x2={312} y2={113} />
            <Edge x1={280} y1={195} x2={312} y2={195} />
            <Edge x1={404} y1={31} x2={432} y2={113} color={C.green} />
            <Edge x1={404} y1={113} x2={432} y2={113} color={C.green} />
            <Edge x1={404} y1={195} x2={432} y2={113} color={C.faint} label="refuted ✗" dashed />
          </svg>
        }
      />

      <Panel style={{ padding: "18px 20px", marginBottom: 22 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip color={C.green}>E3 fix: 26m serial → ≈9m parallel</Chip>
          <Chip color={C.cyan}>every fix adversarially refuted before merge</Chip>
          <Chip color={C.amber}>round 2 auto-escalates to stronger model</Chip>
          <Chip color={C.purple}>scratch worktrees — trunk never sees a bad fix</Chip>
        </div>
      </Panel>

      <Eyebrow>what the script holds — red gate becomes a tournament, not a loop</Eyebrow>
      <Code>
        <K>const</K> hypotheses = <K>await</K> <F>spawnAgent</F>({"{"} role: <S>'triage'</S>, prompt: failure.log, n: 3 {"}"});{"\n\n"}
        <K>const</K> candidates = <K>await</K> Promise.<F>all</F>(hypotheses.<F>map</F>(h =&gt;{"\n"}
        {"  "}<F>spawnAgent</F>({"{"} role: <S>'fixer'</S>, hypothesis: h, cwd: <F>scratchWorktree</F>(h) {"}"})));{"\n\n"}
        <K>const</K> survivors = [];{"\n"}
        <K>for</K> (<K>const</K> c <K>of</K> candidates) {"{"}{"\n"}
        {"  "}<K>const</K> attack = <K>await</K> <F>spawnAgent</F>({"{"} role: <S>'refuter'</S>, target: c.diff,{"\n"}
        {"    "}evidence: failure.preResolutionState {"}"}); <Cm>// evidence preserved, never destroyed</Cm>{"\n"}
        {"  "}<K>if</K> (!attack.broken) survivors.<F>push</F>(c);{"\n"}
        {"}"}{"\n\n"}
        <K>if</K> (survivors.length) <F>merge</F>(<F>vote</F>(survivors));{"\n"}
        <K>else</K> <F>escalate</F>({"{"} model: <S>'stronger'</S>, round: 2 {"}"}); <Cm>// then operator if round 2 fails</Cm>
      </Code>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// WF-3 — Adaptive Router
// ————————————————————————————————————————————————————————————————
function WF3() {
  const lanes = [
    {
      cls: "TYPES-ONLY",
      story: "b9a2310e · extend game types",
      color: C.green,
      chain: ["dev · haiku", "tsc gate"],
      note: "api-author skipped — prework gate already said: no extractable exports",
    },
    {
      cls: "RENDER / VISUAL",
      story: "horse sprite · background · obstacles",
      color: C.blue,
      chain: ["dev · sonnet", "VQA · screenshot review", "batched compile"],
      note: "it's a canvas game — a pixel-art horse deserves eyes, not just tsc",
    },
    {
      cls: "LOGIC / REDUCER",
      story: "controls · spawning · collision · score",
      color: C.amber,
      chain: ["test-author first", "dev · sonnet", "property tests", "batched compile"],
      note: "pure reducers get contract-first TDD + generative inputs",
    },
  ];
  return (
    <div>
      <p style={{ color: C.dim, fontSize: 13.5, lineHeight: 1.7, maxWidth: 760, margin: "0 0 20px" }}>
        The static pipeline gave every story the identical agent chain. Your own log shows the cost:
        api-author spawned on a 1-SP pure-types story right after the prework gate reported
        "no extractable named exports", and compile alone consumed 24.3% of the session (13m18s)
        because each story re-verified in isolation. A workflow opens with a one-shot classifier
        phase, then <em>writes a different chain per story class</em> — and batches the compile
        gate per merge group, since the script (not a context window) is holding the fan-in.
      </p>

      <CompareGrid
        staticSide={
          <div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, lineHeight: 2 }}>
              {["types story", "sprite story", "background story", "collision story"].map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: C.faint, width: 110, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s}</span>
                  {["api-author", "test-author", "dev", "review", "compile"].map((step, j) => (
                    <span
                      key={j}
                      style={{
                        border: `1px solid ${step === "compile" ? C.red + "88" : C.border2}`,
                        color: step === "compile" ? C.red : C.dim,
                        padding: "1px 7px",
                        fontSize: 9,
                      }}
                    >
                      {step}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, fontFamily: MONO, fontSize: 10, color: C.red, letterSpacing: "0.1em" }}>
              SAME CHAIN ×10 STORIES · COMPILE = 24.3% OF WALL TIME
            </div>
          </div>
        }
        dynamicSide={
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {lanes.map((l, i) => (
              <div key={i} style={{ borderLeft: `2px solid ${l.color}`, paddingLeft: 12 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", color: l.color }}>{l.cls}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: C.faint }}>{l.story}</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                  {l.chain.map((step, j) => (
                    <span key={j} style={{ border: `1px solid ${l.color}55`, color: C.fg, fontFamily: MONO, fontSize: 9.5, padding: "2px 8px" }}>
                      {step}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.faint, fontStyle: "italic" }}>{l.note}</div>
              </div>
            ))}
          </div>
        }
      />

      <Panel style={{ padding: "18px 20px", marginBottom: 22 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip color={C.green}>compile 13m18s → ≈4m (batched per merge group)</Chip>
          <Chip color={C.cyan}>haiku on trivial stories — tokens move to verification</Chip>
          <Chip color={C.blue}>VQA enters the chain where pixels exist</Chip>
          <Chip color={C.amber}>quality ↑ where risk lives, cost ↓ where it doesn't</Chip>
        </div>
      </Panel>

      <Eyebrow>what the script holds — the chain is data, decided per story</Eyebrow>
      <Code>
        <K>const</K> plan = <K>await</K> <F>spawnAgent</F>({"{"} role: <S>'classifier'</S>, model: <S>'haiku'</S>,{"\n"}
        {"  "}prompt: <S>'classify each story: types-only | visual | logic'</S>, input: stories {"}"});{"\n\n"}
        <K>const</K> CHAINS = {"{"}{"\n"}
        {"  "}<S>'types-only'</S>: [{"{"} role: <S>'dev'</S>, model: <S>'haiku'</S> {"}"}],{"\n"}
        {"  "}<S>'visual'</S>:    [{"{"} role: <S>'dev'</S> {"}"}, {"{"} role: <S>'vqa'</S>, tools: [<S>'screenshot'</S>] {"}"}],{"\n"}
        {"  "}<S>'logic'</S>:     [{"{"} role: <S>'test-author'</S> {"}"}, {"{"} role: <S>'dev'</S> {"}"}, {"{"} role: <S>'property-tests'</S> {"}"}],{"\n"}
        {"}"};{"\n\n"}
        <K>await</K> Promise.<F>all</F>(plan.<F>map</F>(s =&gt; <F>runChain</F>(CHAINS[s.class], s)));{"\n"}
        <K>await</K> <F>spawnAgent</F>({"{"} role: <S>'compile-gate'</S>, scope: <S>'merge-group'</S> {"}"}); <Cm>// once, not ×10</Cm>
      </Code>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// App
// ————————————————————————————————————————————————————————————————
const TABS = [
  { id: 0, code: "WF-1", name: "Readiness Cascade", thesis: "dissolve the wave walls", C: WF1 },
  { id: 1, code: "WF-2", name: "Fix Swarm", thesis: "the E3 stall, refuted in parallel", C: WF2 },
  { id: 2, code: "WF-3", name: "Adaptive Router", thesis: "one chain per story class", C: WF3 },
];

export default function App() {
  const [tab, setTab] = useState(0);
  const Active = TABS[tab].C;
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.fg, padding: "28px 20px 64px" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 26 }}>
          <Eyebrow color={C.cyan}>futurator pipeline v2.5 · horse-runner1 · replay study</Eyebrow>
          <h1 style={{ fontFamily: MONO, fontWeight: 300, fontSize: 30, letterSpacing: "-0.015em", margin: "0 0 8px" }}>
            Three dynamic workflows vs. the static run
          </h1>
          <p style={{ color: C.dim, fontSize: 13.5, lineHeight: 1.7, maxWidth: 740, margin: 0 }}>
            Same plan, same 10 stories — replayed as if a workflow script, not a fixed bash chain,
            held the orchestration. Projections are derived from your run's own telemetry.
          </p>
        </div>

        {/* Baseline strip — mirrors the console */}
        <Panel
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 18,
            padding: "20px 24px",
            marginBottom: 26,
          }}
        >
          <Metric label="Plan time" value="47m / 15m" color={C.red} sub="3.1× over estimate" />
          <Metric label="Stories" value="8 / 10" color={C.green} sub="E4 never started" />
          <Metric label="E3 fix stall" value="26m 04s" color={C.red} sub="vs 3m budget" />
          <Metric label="Compile share" value="24.3%" color={C.amber} sub="13m18s, per-story" />
          <Metric label="Tokens" value="169k" color={C.cyan} />
          <Metric label="Cost" value="$8.32" color={C.amber} />
        </Panel>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 1, background: C.border, border: `1px solid ${C.border}`, marginBottom: 26, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: "1 1 200px",
                background: tab === t.id ? C.panel2 : C.panel,
                border: "none",
                borderTop: `2px solid ${tab === t.id ? C.cyan : "transparent"}`,
                color: tab === t.id ? C.fg : C.dim,
                padding: "14px 16px",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.22em", color: tab === t.id ? C.cyan : C.faint, marginBottom: 5 }}>
                {t.code}
              </div>
              <div style={{ fontSize: 14, fontWeight: 400, marginBottom: 3 }}>{t.name}</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.faint }}>{t.thesis}</div>
            </button>
          ))}
        </div>

        <Active />

        <div style={{ marginTop: 36, paddingTop: 16, borderTop: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 10, color: C.faint, letterSpacing: "0.06em", lineHeight: 1.8 }}>
          Projections are estimates from the run's own timing telemetry, not measurements. The three
          patterns compose: one production wave could run cascade gating, swarm-on-red, and per-class
          routing in a single script — saved to .claude/workflows/, diffed and improved run over run.
        </div>
      </div>
    </div>
  );
}
