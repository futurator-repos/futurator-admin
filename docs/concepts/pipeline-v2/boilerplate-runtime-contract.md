# Boilerplate Runtime Contract — design

Status: **DESIGN (2026-06-03)**
Motivation: a recurring class of failures where the pipeline _guessed_ how to
install / boot / build / deploy an app instead of the boilerplate _declaring_
it. Closes the "split-brain" gap surfaced by the per-story VQA debugging.

---

## 1. The problem: split-brain between "what the app is" and "how to run it"

When an App is created we pick a **boilerplate** (`nextjs-canvas-game`, `vite-react`,
`expo-mobile`, …). That declares _what the app is_. But every stage that has to
_operate_ the app re-derives the "how" independently, at runtime, generically:

| Stage                                | How it decides "how to run" today                                                                                 | Failure it caused                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Per-story worktree provisioning      | one-size-fits-all **symlinked** `node_modules` (dedup store)                                                      | Next 16 + Turbopack FATAL-panic ("symlink points out of filesystem root") → per-story VQA never captured a screenshot, on _every_ plan |
| `review-runtime` / `qa-prepare` boot | `framework-detect` _guesses_ the dev command + port at runtime by sniffing `package.json`                         | brittle; 30s healthcheck too short for Next 16 cold-start                                                                              |
| Deploy                               | a Haiku agent _improvises_ `basePath` + `output: export` by reading the repo ("I see this is Next.js, not Vite…") | fragile, re-discovers the build shape every deploy; prompt is Vite-worded                                                              |
| `main` / origin sync                 | implicit "this is a Node repo, push to origin"                                                                    | bare-repo refspec quirks                                                                                                               |

Each is a place where a **fact the boilerplate already knows** is instead
_inferred_. Inference is where the mismatches live. The fix is to make the
boilerplate the **single authoritative source of the app's full runtime
contract**, and have every stage _read_ it instead of guessing.

> Key reframing (from the 2026-06-03 discussion): the Turbopack failure was **not**
> a "Node vs Next.js" confusion — Next.js _is_ a Node app; npm packages _are_ Node
> packages. It was an **infra assumption (symlink dedup) colliding with a framework
> tooling rule (Turbopack symlink policy)**. The contract makes such collisions
> impossible to reach by accident, because the boilerplate states the constraint.

---

## 2. The contract

Extend the boilerplate registry (`functions/shared/boilerplates/registry.ts`) so
every boilerplate declares a `runtime` block. Proposed shape:

```ts
interface BoilerplateRuntimeContract {
  // ── Dependency provisioning ────────────────────────────────────────
  /** How a per-story / candidate / QA worktree gets node_modules.
   *  'real'       — must be a real directory (Turbopack & other bundlers that
   *                 reject out-of-root symlinks). cp -a / hardlink from store.
   *  'symlink-ok' — tolerant; the dedup symlink is fine (plain node/CLI, vite). */
  nodeModulesStrategy: 'real' | 'symlink-ok';
  packageManager: 'npm' | 'pnpm' | 'yarn';

  // ── Dev server (review-runtime + qa-prepare) ───────────────────────
  dev: {
    command: string; // e.g. "npm run dev -- --hostname 0.0.0.0 --port 3000"
    port: number; // 3000
    healthPath: string; // "/"
    bootTimeoutSec: number; // 60 — Next 16 + Turbopack cold-start
    bundler?: 'turbopack' | 'webpack' | 'vite' | 'none';
  } | null; // null = no bootable dev server (stub / CLI / lib)

  // ── Build + deploy ─────────────────────────────────────────────────
  build: {
    command: string; // "npm run build"
    outputDir: string; // "out" (next export) | "dist" (vite)
    /** Config the deploy must guarantee before building (no agent improvisation). */
    requiredConfig?: Array<{ file: string; ensure: string }>;
    // e.g. [{ file: 'next.config.ts', ensure: 'output:"export", basePath:"/apps/<appId>"' }]
  } | null;
  deploy: {
    target: 's3-static' | 'none';
    publicUrlPattern: string; // "https://futurator.ai/apps/<appId>/"
    s3Prefix: string; // "apps/<appId>/"
  } | null;
}
```

`<appId>` placeholders are interpolated at use time (the slug fix already
established appId — not plan.name — as the deploy/URL key).

---

## 3. Who reads it (replace guessing with reading)

- **Worktree provisioner** (`story-worktree.mjs` / `node-modules-store.mjs`):
  if `nodeModulesStrategy === 'real'`, materialize a real `node_modules`
  (`cp -a` / hardlink) for the worktree up front, instead of the symlink. This
  is the _root_ fix for the Turbopack panic — currently the daemon patches it
  per-step before `review-runtime`; the contract moves it to provisioning, so
  the dev server is always bootable regardless of which stage runs it.
- **`review-runtime` + `qa-prepare`**: boot with `runtime.dev.command` /
  `port` / `healthPath` / `bootTimeoutSec`. Delete the runtime sniffing in
  `framework-detect` (keep it only as a fallback for un-contracted apps).
- **Deploy** (`/api/epic-workflows/:id/deploy`): replace the freeform Haiku
  agent with a deterministic step that applies `build.requiredConfig`, runs
  `build.command`, syncs `build.outputDir` → `deploy.s3Prefix`, invalidates.
  No more "I see this is Next.js, not Vite" rediscovery.
- **`reducer` / delivery**: already correct after the appId-slug + push fixes;
  the contract just centralizes the URL pattern.

---

## 4. Migration

1. Add `runtime` to the registry; backfill the 2 live starters
   (`nextjs-base`, `nextjs-canvas-game`) with `nodeModulesStrategy: 'real'`,
   `dev.bundler: 'turbopack'`, `bootTimeoutSec: 60`, the static-export build +
   deploy block. Stubs (`sst`, `vite-react`, `expo`) get their blocks as they
   graduate from STUB.
2. Worktree provisioner honors `nodeModulesStrategy` (subsumes the daemon's
   per-step materialize hook for `review-runtime`).
3. `review-runtime` / `qa-prepare` consume `runtime.dev`.
4. Deploy becomes deterministic from `runtime.build` + `runtime.deploy`.
5. `framework-detect` demoted to a fallback for apps with no contract
   (legacy / brownfield with unknown stack).

---

## 5. What it prevents going forward

- **Turbopack-style infra/tooling collisions** — the constraint
  (`nodeModulesStrategy: 'real'`) is stated by the stack that needs it; the
  provisioner can't accidentally hand it an incompatible layout.
- **Deploy improvisation** — basePath/output/outputDir are declared, so a deploy
  can't ship the scaffold or guess the wrong build.
- **Boot flakiness** — the dev command/port/timeout are the stack's truth, not a
  per-run guess.
- **Cross-host portability (see `multi-host-dispatch-readiness.md`)** — a remote
  or local worker can provision + boot + build _any_ app purely from its
  contract, without the dispatching host's tribal knowledge. This contract is a
  **prerequisite** for multi-host dispatch.
