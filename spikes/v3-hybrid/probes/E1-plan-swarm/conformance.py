#!/usr/bin/env python3
# Contract-conformance gate (the A1-stub enforcement, applied to the plan checkout).
# Each parallel epic agent was BLIND to siblings; they only share the frozen contractSurface.
# This checks every domain-type-like token a story references is declared in that surface — i.e.
# no epic invented or redefined a shared name. Prints "ok" or "DRIFT[<tokens>]".
import sys, json, re

def main():
    plan = json.load(open(sys.argv[1]))
    surface = plan.get("contractSurface", [])
    # the declared vocabulary: capitalized identifiers named anywhere in the surface entries
    declared = set()
    for entry in surface:
        for tok in re.findall(r"\b[A-Z][A-Za-z0-9]+\b", entry):
            declared.add(tok)
    # common TS/builtins that are never "shared domain types" — don't flag them
    builtins = {
        "TypeScript","HTML","JSON","Array","Map","Set","Promise","Record","Partial","Math","Date",
        "Object","String","Number","Boolean","RAF","DOM","UI","HUD","WASD","ID","API","MVP","R","P",
    }
    # Conformance only concerns the SHARED contract — a type used ACROSS epics. An epic-internal
    # type (referenced by exactly one epic) is that epic's own business, not drift. So we flag a
    # type-ish token only if (a) it's not in the frozen surface, not a builtin, AND (b) ≥2 epics
    # reference it (genuinely shared → must have come from the surface). This is the correct
    # semantics the heavy run exposed: InputManager (1 epic) is NOT drift; a shared name would be.
    epics_using = {}  # token -> set(epicId)
    for st in plan.get("subtrees", []):
        eid = st.get("epicId", "?")
        blob = json.dumps(st)
        for m in re.findall(r"(?::\s*|<|\b)([A-Z][A-Za-z0-9]+)(?:\[\]|>|\s*\})", blob):
            epics_using.setdefault(m, set()).add(eid)
    drift = set()
    for tok, eids in epics_using.items():
        if tok in declared or tok in builtins:
            continue
        if len(eids) >= 2:  # shared across epics but absent from the frozen surface → real drift
            drift.add(tok)
    if drift:
        print("DRIFT[" + ",".join(sorted(drift)) + "]")
    else:
        print("ok")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("ERR")
