#!/usr/bin/env python3
# reads an epics[] JSON array on stdin; prints "yes" if the dependsOnEpics DAG is acyclic, else "no".
import sys, json
try:
    epics = json.load(sys.stdin)
    ids = {e["epicId"] for e in epics}
    deps = {e["epicId"]: [d for d in e.get("dependsOnEpics", []) if d in ids] for e in epics}
    # Kahn's algorithm
    indeg = {i: 0 for i in ids}
    for i in ids:
        for d in deps[i]:
            indeg[i] += 1
    q = [i for i in ids if indeg[i] == 0]
    seen = 0
    while q:
        n = q.pop()
        seen += 1
        for i in ids:
            if n in deps[i]:
                indeg[i] -= 1
                if indeg[i] == 0:
                    q.append(i)
    print("yes" if seen == len(ids) else "no")
except Exception:
    print("no")
