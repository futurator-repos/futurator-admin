#!/usr/bin/env python3
"""Headless graphify build (AST-only, 0 LLM) for the refactoring recon chain.
Replicates the validated detect -> AST extract -> build(directed) -> cluster -> god_nodes -> to_json
sequence so recon.mjs can run it non-interactively. Writes <out>/graph.json (networkx node-link,
directed: edges under "links" with .source/.target/.relation).

Usage: graphify-build.py <repo> [srcSubdir=src] [outDir=<repo>/graphify-out]

NOTE: all work is under `if __name__ == "__main__"` — graphify.extract() uses a multiprocessing
pool whose workers (spawn start method on macOS/py3.14) re-import this module; without the guard
they re-run the build and crash, producing a degenerate graph.
"""
import sys
import multiprocessing as mp
from pathlib import Path


def main():
    repo = Path(sys.argv[1]).resolve()
    src = sys.argv[2] if len(sys.argv) > 2 else "src"
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else (repo / "graphify-out")
    out.mkdir(parents=True, exist_ok=True)

    from graphify.detect import detect
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes
    from graphify.export import to_json

    det = detect(repo / src)
    code = []
    for f in det.get("files", {}).get("code", []):
        p = Path(f)
        code.extend(collect_files(p) if p.is_dir() else [p])
    res = extract(code, cache_root=repo)
    extraction = {"nodes": res["nodes"], "edges": res["edges"], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}

    # directed=True preserves source->target so fan-in/out and god-object direction are correct
    G = build_from_json(extraction, directed=True)

    # degenerate-build guard: AST worker crashes (resource pressure / spawn bug) yield a tiny/edgeless graph.
    n, e = G.number_of_nodes(), G.number_of_edges()
    if len(code) >= 5 and (n < len(code) or e == 0):
        print(f"! degenerate build: {n} nodes / {e} edges for {len(code)} code files "
              f"(likely AST worker crash). Aborting.", file=sys.stderr)
        sys.exit(3)

    communities = cluster(G)
    score_all(G, communities)
    god_nodes(G)
    to_json(G, communities, str(out / "graph.json"))
    print(f"graphify-build: {n} nodes, {e} edges, {len(communities)} communities (AST, directed, 0 LLM)")


if __name__ == "__main__":
    mp.freeze_support()
    main()
