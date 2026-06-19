#!/usr/bin/env bash
# A1 — shared-contract blind-dev probe (spike test plan §1).
#
# Tests O2: does blind-dev reproduce the documented shared-contract drift
# (test-dev-contract-incident.md) when two stories share an ambiguous contract?
#
# Two arms (pass --stub for arm ii):
#   (i)  --no-stub : producer + consumer get only the prose contract → must GUESS the field name
#   (ii) --stub    : a frozen src/lineItem.d.ts disambiguates both before either writes
#
# ORACLE (deterministic, independent of vitest): after a BLIND parallel build and merge,
#   does `tsc --noEmit` pass? In blind mode neither agent can see the other's output, so a
#   field-name mismatch (producer writes .subtotal, consumer reads .lineTotal) is caught ONLY
#   by tsc at merge — there is no reconciliation round to rescue it (the incident's lucky escape
#   is structurally removed). tsc FAIL = drift. We also record the actual producer field name
#   and the consumer's expected field name for the forensic record.
#
# Emits one machine-readable line for the A3 stat harness:
#   PROBE-RESULT: A1 arm=<no-stub|stub> drift=<yes|no> tsc=<PASS|FAIL> prodField=<name> consField=<name>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"        # spikes/v3-hybrid
ARM=no-stub; [[ "${1:-}" == "--stub" ]] && ARM=stub
PLAN="$HERE/plan.json"
WORK="${SPIKE_WORK:-/tmp/v3-A1-$ARM-$(date +%s)}"
SP="$WORK/.spike"; LOG="$SP/run.log"; mkdir -p "$WORK/wt" "$SP"; : > "$LOG"
say(){ printf '\n▸ %s\n' "$*"; }

run_workflow(){ # $1 script  $2 outfile  $3 args(JSON)
  : > "$2"
  claude -p "Run the dynamic workflow at the file path: $1
Use this object as the workflow \`args\` (it is JSON): $3
When it returns, use Write to save its EXACT return value as JSON to: $2
Then output only: DONE" \
    --allowedTools "Read,Grep,Glob,Edit,Write,Bash,Task,Workflow" \
    --permission-mode bypassPermissions < /dev/null >>"$LOG" 2>&1 || true
  [[ -s "$2" ]] || { echo "✗ no workflow output: $1 (see $LOG)"; exit 1; }
}

say "0. scaffold ($ARM arm) at $WORK"
cd "$WORK"; git init -q; git config user.email a1@local; git config user.name a1
cat > package.json <<'JSON'
{ "name":"v3-A1","type":"module","private":true,
  "devDependencies":{"vitest":"^2.1.0","typescript":"^5.5.0"} }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions":{ "strict":true,"noEmit":true,"module":"esnext","target":"es2022",
  "moduleResolution":"bundler","skipLibCheck":true,"types":[] }, "include":["src"] }
JSON
mkdir -p src; echo "node_modules" > .gitignore

# arm (ii): land the frozen contract stub BEFORE any dev work
if [[ "$ARM" == stub ]]; then
  jq -r '.stub.content' "$PLAN" > "src/$(jq -r '.stub.file' "$PLAN" | xargs basename)"
  echo "  ✓ frozen stub committed: $(jq -r '.stub.file' "$PLAN")"
fi
git add -A; git commit -qm "base scaffold ($ARM)"; git branch -f base HEAD

# blind worktrees BEFORE tests/impl exist on them
while read -r id; do git worktree add -q "$WORK/wt/$id" -b "wip/$id" base; done \
  < <(jq -r '.stories[].id' "$PLAN")

say "1. BLIND parallel dev (producer + consumer, neither sees the other)"
RULES="$(cat "$ROOT/dev-rules.md")"
STUB_HINT=""
[[ "$ARM" == stub ]] && STUB_HINT="A frozen contract stub exists at src/lineItem.d.ts — import/conform to it EXACTLY."
DEV_ARGS=$(jq -c --arg w "$WORK/wt" --arg r "$RULES" --arg sh "$STUB_HINT" \
  '{brief:$sh, rules:$r, injectViolationFor:"", stories:[.stories[]|{id,file,contract,acs, worktreePath:($w+"/"+.id)}]}' "$PLAN")
run_workflow "$ROOT/workflows/dev.workflow.js" "$SP/dev.json" "$DEV_ARGS"
while read -r id; do
  git -C "$WORK/wt/$id" add -A; git -C "$WORK/wt/$id" commit -qm "story $id" || true
done < <(jq -r '.stories[].id' "$PLAN")

# capture the ACTUAL field names each side chose, BEFORE merge (forensic record)
PROD_WT="$WORK/wt/producer-lineitem"; CONS_WT="$WORK/wt/consumer-cart"
# name-agnostic: first numeric field declared in the producer's interface, and the field the consumer reads
prodField=$(grep -oE '[A-Za-z_][A-Za-z0-9_]*\s*:\s*number' "$PROD_WT/src/lineItem.ts" 2>/dev/null | head -1 | sed -E 's/\s*:.*//' || echo "?")
consField=$(grep -oE '\.[A-Za-z_][A-Za-z0-9_]*\b' "$CONS_WT/src/cart.ts" 2>/dev/null | grep -vE '\.(reduce|map|filter|toBe|length|push|forEach)\b' | head -1 | tr -d '.' || echo "?")

for id in producer-lineitem consumer-cart; do git worktree remove --force "$WORK/wt/$id" 2>/dev/null || true; done

say "2. MERGE + tsc oracle (the drift detector)"
git checkout -q -b a1/main base
git merge -q --no-ff wip/producer-lineitem -m "merge producer"
git merge -q --no-ff wip/consumer-cart -m "merge consumer"
npm install --silent --no-audit --no-fund >>"$LOG" 2>&1 || true
if npx tsc --noEmit >>"$LOG" 2>&1; then TSC=PASS; else TSC=FAIL; fi
DRIFT=no; [[ "$TSC" == FAIL ]] && DRIFT=yes

say "RESULT"
echo "  producer field=$prodField  consumer reads=$consField  tsc=$TSC  drift=$DRIFT"
echo "PROBE-RESULT: A1 arm=$ARM drift=$DRIFT tsc=$TSC prodField=$prodField consField=$consField work=$WORK"
