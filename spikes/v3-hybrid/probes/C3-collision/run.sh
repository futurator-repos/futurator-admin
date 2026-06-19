#!/usr/bin/env bash
# C3 — merge-collision / refuter-before-merge (I3) probe (spike test plan §3).
#
# Tests O8: when two stories edit the SAME file (a touch-point collision the current spike
# forbids by construction), does the pipeline DETECT the collision at merge and refuse to
# land it silently, or does it auto-resolve without an adversary (violating I3)?
#
# Setup: two blind stories both told to write src/shared.ts with different content.
# Oracle: the second `git merge --no-ff` must CONFLICT (exit non-zero) → detected. A silent
# auto-resolution (merge succeeds with one side clobbered, no refuter) = I3 violation.
# Emits: PROBE-RESULT: C3 collisionDetected=<yes|no> autoResolved=<yes|no> work=<dir>
set -euo pipefail
WORK="${SPIKE_WORK:-/tmp/v3-C3-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$WORK/src" "$SP"; LOG="$SP/run.log"; : > "$LOG"
cd "$WORK"; git init -q; git config user.email c3@local; git config user.name c3
cat > package.json <<'J'
{ "name":"c3","type":"module","private":true }
J
echo node_modules > .gitignore; printf 'export const VERSION = 0\n' > src/shared.ts
git add -A; git commit -qm base; git branch -f base HEAD
git worktree add -q "$WORK/wt/a" -b wip/a base
git worktree add -q "$WORK/wt/b" -b wip/b base
claude -p "Edit $WORK/wt/a/src/shared.ts: add 'export const FEATURE_A = true' and set VERSION=1. Output DONE." \
  --allowedTools "Read,Write,Edit" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true
claude -p "Edit $WORK/wt/b/src/shared.ts: add 'export const FEATURE_B = true' and set VERSION=2. Output DONE." \
  --allowedTools "Read,Write,Edit" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true
for w in a b; do git -C "$WORK/wt/$w" add -A; git -C "$WORK/wt/$w" commit -qm "$w" || true; done
for w in a b; do git worktree remove --force "$WORK/wt/$w" 2>/dev/null || true; done

git checkout -q -b c3/main base
git merge -q --no-ff wip/a -m "merge a"
COLL=no; AUTO=no
if git merge -q --no-ff wip/b -m "merge b" >>"$LOG" 2>&1; then
  AUTO=yes   # second merge succeeded with no conflict — silent auto-resolution (I3 risk)
else
  COLL=yes; git merge --abort 2>/dev/null || true   # conflict surfaced — detected, halts for refuter
fi
echo "PROBE-RESULT: C3 collisionDetected=$COLL autoResolved=$AUTO work=$WORK"
