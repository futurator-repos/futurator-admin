/* global React */
const { useState, useRef, useEffect, useMemo } = React;

const STATUS_META = {
  concept:    { label: "Concept",    color: "#7a8090", dot: "#a0a3ab" },
  developing: { label: "Developing", color: "#a78bfa", dot: "#a78bfa" },
  fixing:     { label: "Fixing",     color: "#ef4444", dot: "#ef4444" },
  review:     { label: "Review",     color: "#d1a54f", dot: "#d1a54f" },
  delivered:  { label: "Delivered",  color: "#22c55e", dot: "#22c55e" },
  archived:   { label: "Archived",   color: "#4a4d55", dot: "#4a4d55" },
};

const STORY_STATUS = {
  pending:   { label: "Backlog",    color: "#64748b" },
  queued:    { label: "Queued",     color: "#94a3b8" },
  running:   { label: "Developing", color: "#a78bfa" },
  in_review: { label: "In review",  color: "#f59e0b" },
  fixing:    { label: "Fixing",     color: "#ef4444" },
  done:      { label: "Done",       color: "#22c55e" },
  failed:    { label: "Failed",     color: "#ef4444" },
  blocked:   { label: "Blocked",    color: "#f43f5e" },
  skipped:   { label: "Skipped",    color: "#475569" },
};

// Kanban collapses the extended story statuses into 5 user-facing columns
const KANBAN_COLS = [
  { id: "pending",   label: "Backlog",    matches: ["pending", "skipped"] },
  { id: "queued",    label: "Queued",     matches: ["queued"] },
  { id: "running",   label: "Developing", matches: ["running", "fixing"] },
  { id: "in_review", label: "In review",  matches: ["in_review"] },
  { id: "done",      label: "Done",       matches: ["done"] },
];

function fmtSec(s) {
  if (s == null) return "—";
  const m = Math.floor(s / 60), sc = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sc}s` : `${sc}s`;
}
function fmtCost(c) { return `$${(c || 0).toFixed(2)}`; }
function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

// Aggregate time/cost/tokens/progress up the hierarchy.
// Wave time = max(story time), Epic time = sum(waves), Plan time = sum(epics) when sequential.
function aggregateWave(wave) {
  const stories = wave.stories;
  const planned = Math.max(0, ...stories.map(s => s.plannedSec || 0));
  // actual: max of story elapsed — if any running, take planned/progress-based elapsed
  const storyElapsed = stories.map(s => {
    if (s.status === "done") return s.actualSec || s.plannedSec || 0;
    if (s.status === "running" || s.status === "in_review" || s.status === "fixing") {
      const prog = (s.progress || 50) / 100;
      return (s.plannedSec || 0) * prog;
    }
    return 0;
  });
  const actual = Math.max(0, ...storyElapsed);
  const cost = stories.reduce((a, s) => a + (s.cost || 0), 0);
  const tokens = stories.reduce((a, s) => a + (s.tokens || 0), 0);
  const done = stories.filter(s => s.status === "done").length;
  const running = stories.filter(s => ["running","in_review","fixing"].includes(s.status)).length;
  const progress = stories.length
    ? stories.reduce((a, s) => {
        if (s.status === "done") return a + 100;
        if (s.status === "running" || s.status === "in_review") return a + (s.progress || 50);
        return a;
      }, 0) / stories.length
    : 0;
  return { planned, actual, cost, tokens, done, running, total: stories.length, progress };
}
function aggregateEpic(epic) {
  const waveAggs = epic.waves.map(aggregateWave);
  return {
    planned: waveAggs.reduce((a, w) => a + w.planned, 0),
    actual:  waveAggs.reduce((a, w) => a + w.actual,  0),
    cost:    waveAggs.reduce((a, w) => a + w.cost,    0),
    tokens:  waveAggs.reduce((a, w) => a + w.tokens,  0),
    done:    waveAggs.reduce((a, w) => a + w.done,    0),
    total:   waveAggs.reduce((a, w) => a + w.total,   0),
    running: waveAggs.reduce((a, w) => a + w.running, 0),
    progress: waveAggs.length
      ? waveAggs.reduce((a, w) => a + w.progress * w.total, 0) /
        Math.max(1, waveAggs.reduce((a, w) => a + w.total, 0))
      : 0,
  };
}
function aggregatePlan(plan) {
  const epicAggs = plan.epics.map(aggregateEpic);
  return {
    planned: epicAggs.reduce((a, e) => a + e.planned, 0),
    actual:  epicAggs.reduce((a, e) => a + e.actual,  0),
    cost:    epicAggs.reduce((a, e) => a + e.cost,    0),
    tokens:  epicAggs.reduce((a, e) => a + e.tokens,  0),
    done:    epicAggs.reduce((a, e) => a + e.done,    0),
    total:   epicAggs.reduce((a, e) => a + e.total,   0),
    running: epicAggs.reduce((a, e) => a + e.running, 0),
    progress: epicAggs.length
      ? epicAggs.reduce((a, e) => a + e.progress * e.total, 0) /
        Math.max(1, epicAggs.reduce((a, e) => a + e.total, 0))
      : 0,
  };
}

Object.assign(window, {
  STATUS_META, STORY_STATUS, KANBAN_COLS,
  fmtSec, fmtCost, fmtTokens,
  aggregateWave, aggregateEpic, aggregatePlan,
});
