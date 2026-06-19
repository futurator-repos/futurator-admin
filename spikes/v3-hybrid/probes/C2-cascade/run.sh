#!/usr/bin/env bash
# C2 — readiness-cascade (WF-1) probe (spike test plan §3).
#
# Tests O1/O5 + open Q#1: is `contract-stable` (producer's TYPES committed) a SAFE point
# to release a dependent, before the producer is `fully-done`? The WF-1 headline win
# (47m→26m, E4 idle→0) assumes yes. This builds the dependent against the producer's
# published .d.ts IN PARALLEL with the producer's implementation, then asks: did the
# dependent need rework when the producer's real impl landed?
#
# Oracle: after merge, tsc --noEmit. rework=yes iff tsc FAILS — i.e. the producer's final
# implementation diverged from the contract the dependent was released against.
# Emits: PROBE-RESULT: C2 rework=<yes|no> tsc=<PASS|FAIL> work=<dir>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${SPIKE_WORK:-/tmp/v3-C2-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$WORK/src" "$SP"; LOG="$SP/run.log"; : > "$LOG"
cd "$WORK"; git init -q; git config user.email c2@local; git config user.name c2
cat > package.json <<'J'
{ "name":"c2","type":"module","private":true,"devDependencies":{"typescript":"^5.5.0"} }
J
cat > tsconfig.json <<'J'
{ "compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","skipLibCheck":true,"types":[]},"include":["src"] }
J
# contract-stable tier: producer publishes ONLY its types/signature first
cat > src/store.d.ts <<'TS'
export interface Account { id: string; balanceCents: number }
export function getBalance(a: Account): number;   // dollars, balanceCents/100
TS
echo node_modules > .gitignore; git add -A; git commit -qm "contract-stable: types published"; git branch -f base HEAD

# release the DEPENDENT now (against contract-stable) IN PARALLEL with producer impl
git worktree add -q "$WORK/wt/dep" -b wip/dep base
git worktree add -q "$WORK/wt/prod" -b wip/prod base
( claude -p "Implement $WORK/wt/dep/src/report.ts: export function report(a: import('./store').Account): string returning
   'Balance: \$' + getBalance(a) (import getBalance + Account from './store'). Conform EXACTLY to src/store.d.ts. Output DONE." \
   --allowedTools "Read,Write" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true ) &
( claude -p "Implement $WORK/wt/prod/src/store.ts to satisfy src/store.d.ts EXACTLY (same names/shapes):
   export interface Account {id;balanceCents}; export function getBalance(a){return a.balanceCents/100}. Output DONE." \
   --allowedTools "Read,Write" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true ) &
wait
for w in dep prod; do git -C "$WORK/wt/$w" add -A; git -C "$WORK/wt/$w" commit -qm "$w" || true; done
for w in dep prod; do git worktree remove --force "$WORK/wt/$w" 2>/dev/null || true; done

git checkout -q -b c2/main base
git merge -q --no-ff wip/prod -m "merge producer impl"
git merge -q --no-ff wip/dep -m "merge dependent" || true
npm install --silent --no-audit --no-fund >>"$LOG" 2>&1 || true
if npx tsc --noEmit >>"$LOG" 2>&1; then TSC=PASS; REWORK=no; else TSC=FAIL; REWORK=yes; fi
echo "PROBE-RESULT: C2 rework=$REWORK tsc=$TSC work=$WORK"
