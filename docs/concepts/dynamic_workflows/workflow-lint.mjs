#!/usr/bin/env node
/**
 * workflow-lint.mjs — pre-launch invariant linter for dynamic workflow scripts.
 * Futurator Pipeline v2.5 · enforces .claude/skills/workflow-authoring/SKILL.md (v1)
 *
 * Usage:
 *   node workflow-lint.mjs <workflow.js> [plan.json] [--json]
 *
 *   <workflow.js>  path to the generated workflow script
 *                  (e.g. the file under ~/.claude/projects/<session>/...)
 *   [plan.json]    optional plan descriptor: { stories: [{ id, class?, touchPoints: [] }] }
 *                  enables plan-aware checks (I2 visual→VQA).
 *   --json         machine-readable report on stdout (for the supervisor).
 *
 * Exit codes: 0 = pass · 1 = invariant violations · 2 = usage/parse error
 *
 * Honest scope note: this is a structural linter (regex + heuristics over JS
 * source), not a semantic verifier. It catches missing phases, missing caps,
 * forbidden ops, and model-floor violations. Pair it with the Haiku semantic
 * review in lint-and-launch.sh for intent-level checks. Determinism here,
 * judgment there.
 */

import { readFileSync } from "node:fs";

// ———————————————————————————————————————————— config
const VERIFICATION_ROLES = ["test-author", "qa", "property-tests", "compile-gate"];
const ADVERSARIAL_ROLES = ["refuter"];
const GATE_ROLES = ["refuter", "compile-gate", "merge-gate"];
const VISUAL_TOUCHPOINT_RE =
  /\.(tsx|jsx|css|scss|svg)$|components\/|canvas|render|sprite|shader|\bui\b/i;
const MODEL_FLOOR_BANNED = ["haiku"]; // for GATE_ROLES

// ———————————————————————————————————————————— cli
const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const files = argv.filter((a) => a !== "--json");
if (files.length < 1) {
  console.error("usage: workflow-lint.mjs <workflow.js> [plan.json] [--json]");
  process.exit(2);
}

let src;
try {
  src = readFileSync(files[0], "utf8");
} catch (e) {
  console.error(`cannot read workflow script: ${e.message}`);
  process.exit(2);
}

let plan = null;
if (files[1]) {
  try {
    plan = JSON.parse(readFileSync(files[1], "utf8"));
  } catch (e) {
    console.error(`cannot parse plan json: ${e.message}`);
    process.exit(2);
  }
}

// strip comments/strings copies for some checks, keep raw for others
const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ———————————————————————————————————————————— helpers
const findings = [];
const ok = [];
const fail = (id, msg) => findings.push({ id, msg });
const pass = (id, msg) => ok.push({ id, msg });

/** all role literals declared as { role: '<name>' } */
function roles() {
  const out = new Set();
  for (const m of noComments.matchAll(/role\s*:\s*['"`]([\w-]+)['"`]/g)) out.add(m[1]);
  return out;
}

/** crude object-scope scan: does any object literal contain both role X and model Y? */
function roleHasModel(role, model) {
  // window of 300 chars after a role declaration, bounded by '}' nesting heuristic
  const re = new RegExp(`role\\s*:\\s*['"\`]${role}['"\`][^}]{0,300}`, "g");
  for (const m of noComments.matchAll(re)) {
    if (new RegExp(`model\\s*:\\s*['"\`]${model}`).test(m[0])) return true;
  }
  // also catch model declared before role in the same object
  const re2 = new RegExp(`model\\s*:\\s*['"\`]${model}['"\`][^}]{0,300}role\\s*:\\s*['"\`]${role}['"\`]`, "g");
  return re2.test(noComments);
}

const declaredRoles = roles();
const has = (r) => declaredRoles.has(r);

// ———————————————————————————————————————————— checks

// C0 · header marker
if (/^\s*\/\/\s*@workflow-invariants:\s*v1/m.test(src)) {
  pass("C0", "invariants header present (@workflow-invariants: v1)");
} else {
  fail("C0", "missing '// @workflow-invariants: v1' header — SKILL.md was not applied");
}

// C1 · I1 verification phase exists at all
if (VERIFICATION_ROLES.some(has)) {
  pass("C1", `verification phase present (${VERIFICATION_ROLES.filter(has).join(", ")})`);
} else {
  fail("C1", `no verification role found — every chain must end in one of: ${VERIFICATION_ROLES.join(", ")}`);
}

// C2 · I2 visual touch-points → vqa role (plan-aware; degrades to script-only hint)
const planVisual =
  plan?.stories?.some(
    (s) =>
      (s.touchPoints || []).some((t) => VISUAL_TOUCHPOINT_RE.test(t)) ||
      /visual|render|ui/i.test(s.class || "")
  ) ?? null;
if (planVisual === true) {
  if (has("vqa")) pass("C2", "plan has visual touch-points and a 'vqa' role is present");
  else fail("C2", "plan contains visual/UI touch-points but no 'vqa' role in script (I2)");
} else if (planVisual === false) {
  pass("C2", "plan has no visual touch-points — VQA not required");
} else {
  // no plan provided — fall back to script self-evidence
  if (VISUAL_TOUCHPOINT_RE.test(noComments) && !has("vqa")) {
    fail("C2", "script references visual surfaces but declares no 'vqa' role (no plan.json given; pass one to silence false positives)");
  } else {
    pass("C2", "no plan.json provided; no visual references without VQA detected");
  }
}

// C3 · I3 merge requires a refuter declared before first merge()
const mergeIdx = noComments.search(/\bmerge\s*\(/);
if (mergeIdx === -1) {
  pass("C3", "no merge() calls — invariant I3 not applicable");
} else {
  const refIdx = noComments.search(/role\s*:\s*['"`]refuter['"`]/);
  if (refIdx !== -1 && refIdx < mergeIdx) {
    pass("C3", "refuter phase declared before merge()");
  } else if (refIdx !== -1) {
    fail("C3", "refuter exists but first merge() appears before any refuter declaration — reorder so adversarial review precedes merging (I3)");
  } else {
    fail("C3", "merge() called but no 'refuter' role anywhere in script (I3)");
  }
}

// C4 · I6 fix loops capped + escalation ladder
const hasFixer = has("fixer") || /\b(fixLoop|retr(y|ies))\b/i.test(noComments);
if (hasFixer) {
  const capped = /\bmaxRounds\s*[:=]\s*\d+/.test(noComments) || /\bround\s*(<|<=)\s*\d+/.test(noComments);
  const escalates = /\bescalate\s*\(/.test(noComments);
  if (capped && escalates) pass("C4", "fix loop has numeric cap and escalate() path");
  if (!capped) fail("C4", "fixer/retry logic present without a numeric cap (maxRounds) — unbounded loops forbidden (I6)");
  if (!escalates) fail("C4", "fixer/retry logic present without escalate() — exhaustion must route to stronger model / operator (I6)");
} else {
  pass("C4", "no fix/retry logic — I6 not applicable");
}

// C5 · I5 fixers use scratch worktrees
if (has("fixer")) {
  if (/scratchWorktree\s*\(/.test(noComments)) pass("C5", "fixer roles reference scratchWorktree()");
  else fail("C5", "fixer role present but no scratchWorktree() — fixes must not run on story branches or trunk (I5)");
} else {
  pass("C5", "no fixer roles — I5 not applicable");
}

// C6 · I7 model floors on gate roles
let floorViolations = [];
for (const role of GATE_ROLES) {
  if (!has(role)) continue;
  for (const banned of MODEL_FLOOR_BANNED) {
    if (roleHasModel(role, banned)) floorViolations.push(`${role}→${banned}`);
  }
}
if (floorViolations.length) {
  fail("C6", `model floor violation: ${floorViolations.join(", ")} — gate/adversarial roles require sonnet+ (I7)`);
} else {
  pass("C6", "no gate role assigned a sub-floor model");
}

// C7 · I9 forbidden operations
const FORBIDDEN = [
  [/git\s+push[^\n]*--force(?!-with-lease)/, "git push --force (use --force-with-lease only where permitted)"],
  [/--no-verify\b/, "--no-verify (hook bypass)"],
  [/rm\s+-rf\s+(\/|\.\s|\$\{?REPO|\$\{?HOME)/, "rm -rf on repo/home root"],
  [/git\s+push[^\n]*\b(origin\s+)?(main|master|trunk)\b(?![\w-])/, "direct push to trunk"],
  [/rm\s+-rf\s+[^\n]*\.pipeline/, "deleting .pipeline evidence directory (I4)"],
];
const hits = FORBIDDEN.filter(([re]) => re.test(noComments)).map(([, label]) => label);
if (hits.length) fail("C7", `forbidden operations: ${hits.join("; ")} (I9)`);
else pass("C7", "no forbidden git/fs operations detected");

// C8 · I8 durable checkpoints
if (/\bcheckpoint\s*\(/.test(noComments) || /git\s+commit/.test(noComments)) {
  pass("C8", "checkpointing present (checkpoint() or git commit)");
} else {
  fail("C8", "no checkpoint()/git commit found — completed work must survive instance death (I8)");
}

// C9 · I4 evidence preservation when fixing/resolving
if (hasFixer || /resolv/i.test(noComments)) {
  if (/preResolution|evidence|baseline/i.test(noComments)) {
    pass("C9", "evidence/baseline references present alongside fix/resolve logic");
  } else {
    fail("C9", "fix/resolve logic without any evidence/baseline preservation reference (I4)");
  }
} else {
  pass("C9", "no fix/resolve logic — I4 not applicable");
}

// ———————————————————————————————————————————— report
const result = {
  script: files[0],
  plan: files[1] || null,
  rolesDeclared: [...declaredRoles].sort(),
  passed: ok,
  violations: findings,
  verdict: findings.length === 0 ? "PASS" : "FAIL",
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const W = (s) => s.padEnd(4);
  console.log(`\nworkflow-lint · ${result.script}`);
  console.log(`roles: ${result.rolesDeclared.join(", ") || "(none found — check structural conventions)"}\n`);
  for (const p of ok) console.log(`  ✓ ${W(p.id)} ${p.msg}`);
  for (const f of findings) console.log(`  ✗ ${W(f.id)} ${f.msg}`);
  console.log(`\nverdict: ${result.verdict}\n`);
}
process.exit(findings.length === 0 ? 0 : 1);
