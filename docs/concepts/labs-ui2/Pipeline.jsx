/* global React, STATUS_META */
const { useState: usePS, useEffect: ueffPS } = React;

// Project pipeline: Concept → Developing → QA Review → Deploy → Published
const PIPELINE_STAGES = [
  { id: "concept",    label: "Concept",    sub: "intent drafted" },
  { id: "developing", label: "Developing", sub: "agents running" },
  { id: "qa",         label: "QA Review",  sub: "visual + PO audit" },
  { id: "deploy",     label: "Deploy",     sub: "push to S3" },
  { id: "published",  label: "Published",  sub: "live on futurator.ai" },
];

// Map plan.status to pipeline position
function stageIndexFor(status) {
  switch (status) {
    case "concept":    return 0;
    case "developing": return 1;
    case "fixing":     return 1;
    case "review":     return 2;
    case "delivered":  return 4;
    case "archived":   return 0;
    default:           return 0;
  }
}

function Pipeline({ project }) {
  const idx = stageIndexFor(project.status);
  const isFixing = project.status === "fixing";

  return (
    <div style={{
      padding: "18px 24px",
      border: "1px solid var(--border)",
      borderRadius: 12,
      background: "linear-gradient(180deg, rgba(255,255,255,0.015), transparent)",
      marginTop: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.22em" }}>
          Project Pipeline
        </span>
        <div style={{ flex: 1, height: 1, background: "var(--border)" }}/>
        <span className="mono" style={{ fontSize: 10, color: isFixing ? "var(--red)" : "var(--text-mute)", letterSpacing: "0.05em" }}>
          {isFixing ? "⚠ fixing — blocked at developing" : `stage ${idx + 1} of ${PIPELINE_STAGES.length}`}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
        {PIPELINE_STAGES.map((s, i) => {
          const isDone = i < idx;
          const isCurrent = i === idx;
          const isFuture = i > idx;
          const color = isDone ? "var(--text-dim)"
            : isCurrent ? (isFixing ? "var(--red)" : "var(--text)")
            : "var(--text-faint)";
          const dotColor = isDone ? "var(--text-dim)"
            : isCurrent ? (isFixing ? "var(--red)" : "var(--amber)")
            : "var(--border-2)";

          return (
            <React.Fragment key={s.id}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", position: "relative", minWidth: 0 }}>
                {/* Dot / ring */}
                <div style={{ position: "relative", height: 26, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {isCurrent && (
                    <span style={{
                      position: "absolute", width: 26, height: 26, borderRadius: "50%",
                      border: `1px solid ${dotColor}`, opacity: 0.5,
                      animation: "pulse 2s ease-in-out infinite",
                    }}/>
                  )}
                  <span style={{
                    width: isCurrent ? 12 : 8, height: isCurrent ? 12 : 8, borderRadius: "50%",
                    background: isFuture ? "transparent" : dotColor,
                    border: isFuture ? `1px solid ${dotColor}` : "none",
                    boxShadow: isCurrent ? `0 0 12px ${isFixing ? "#ef444466" : "#d1a54f55"}` : "none",
                    transition: "all 300ms",
                  }}/>
                </div>
                <div style={{ marginTop: 10, textAlign: "center", padding: "0 8px" }}>
                  <div style={{
                    fontSize: 13, fontWeight: isCurrent ? 500 : 400,
                    color, letterSpacing: isCurrent ? "0.01em" : 0,
                    transition: "color 200ms",
                  }}>{s.label}</div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", marginTop: 3, letterSpacing: "0.06em" }}>
                    {isCurrent && !isFixing ? "— in progress —"
                     : isCurrent && isFixing ? "— recovering —"
                     : s.sub}
                  </div>
                </div>
              </div>

              {/* Connector line */}
              {i < PIPELINE_STAGES.length - 1 && (
                <div style={{ flexShrink: 0, width: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 12 }}>
                  <div style={{
                    height: 1, width: "100%",
                    background: i < idx
                      ? "var(--text-dim)"
                      : `linear-gradient(90deg, ${i < idx ? "var(--text-dim)" : "var(--border-2)"}, var(--border))`,
                    transition: "background 200ms",
                  }}/>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

window.Pipeline = Pipeline;
window.PIPELINE_STAGES = PIPELINE_STAGES;
