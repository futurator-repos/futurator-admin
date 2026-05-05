# Tech Spec — GitHub Integration (Portable)

This spec captures the GitHub integration as built in Mycelium, distilled so an agent can re-implement it in another Next.js + React app. It also adds a **Create Repo from UI** capability that is not yet in Mycelium today.

The integration is **PAT-based** (Personal Access Token, server-side only). There is no OAuth flow, no callback URLs, no client-side tokens.

---

## 1. Architecture overview

Three layers, server-trusts-PAT, client-talks-only-to-our-API:

```
┌────────────────────────────────────┐
│  React component (client)          │
│  src/components/github-browser.tsx │
└──────────────┬─────────────────────┘
               │ fetch("/api/github/...")
               ▼
┌────────────────────────────────────┐
│  Next.js Route Handlers (server)   │
│  src/app/api/github/**/route.ts    │
└──────────────┬─────────────────────┘
               │ GitHub REST v3 + Bearer PAT
               ▼
┌────────────────────────────────────┐
│  GitHub connector (server)         │
│  src/lib/github.ts                 │
└────────────────────────────────────┘
```

**Hard rules:**
- `GITHUB_PAT` is read **only** in `src/lib/github.ts`. Never imported into a `"use client"` file.
- All GitHub API calls go through `githubFetch()` so the rate-limit headers are captured in one place.
- Errors throw `GitHubError(message, status, rateLimit)`; routes translate that to JSON + matching HTTP status.

---

## 2. Required dependencies

The integration uses only Next.js + React + Tailwind + a few icons. No Octokit. No external SDK.

```jsonc
// package.json (already present in most Next 15 + React 19 stacks)
{
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "lucide-react": "^0.575.0"
  }
}
```

If the target app does not have `lucide-react`, swap the icons or add the dep. The component also imports `@/components/ui/scroll-area` and `@/lib/utils` (`cn`) — these are shadcn/ui conventions; replace with plain `div` / `clsx` if the target app lacks them.

---

## 3. Environment variables

Only **one** key is required. Add to `.env.local` of the target app:

```bash
# GitHub Personal Access Token (server-only — never exposed to client)
GITHUB_PAT=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Optional fallback name supported by the connector: `GITHUB_TOKEN` (used if `GITHUB_PAT` is unset).

### How to mint the PAT

GitHub → Settings → Developer settings → **Personal access tokens** → *Fine-grained tokens*.

- **Resource owner**: your user (or org if reading org repos)
- **Repository access**: All repositories *or* selected repos
- **Permissions** (Repository):
  - `Contents` → **Read and write** (read = browse files; write = needed for *Create repo* + future commits)
  - `Metadata` → Read-only (auto-granted)
  - `Administration` → **Read and write** (only required if you want *Create repo* — see §7)
- **Permissions** (Account): none

Classic PAT works too with scopes `repo` (and `delete_repo` if you ever need destructive ops). Fine-grained is preferred.

> **Copy from Mycelium**: the only env line to copy is `GITHUB_PAT=...`. Same token can be reused across apps as long as the scopes are sufficient.

---

## 4. File-by-file implementation

Paths assume the standard `src/` layout with `@/*` → `src/*` alias. All files are server code unless marked `"use client"`.

### 4.1 `src/lib/github.ts` — the connector

Single source of truth for talking to api.github.com. Pure functions, no React, no Next imports.

Public surface (copy verbatim from Mycelium):

| Export | Purpose |
|---|---|
| `GitHubError` | Custom error class with `status` + `rateLimit`. |
| `getUser()` | `GET /user` — auth check + profile. |
| `listRepos(perPage = 100)` | `GET /user/repos?sort=pushed` — repo dropdown source. |
| `getRepo(owner, repo)` | `GET /repos/{o}/{r}` — single repo metadata. |
| `getRepoTree(owner, repo, branch="main")` | `GET /repos/{o}/{r}/git/trees/{b}?recursive=1` — full tree. |
| `getFileContent(owner, repo, path, ref?)` | `GET /repos/{o}/{r}/contents/{path}` — base64 content. |
| `checkConnection()` | Wraps `getUser()`, returns `{ connected, login?, error? }`. |
| **NEW** `createRepo(input)` | `POST /user/repos` — see §7. |

Key implementation details:
- Reads token via `process.env.GITHUB_PAT || process.env.GITHUB_TOKEN`. Throws `GitHubError(..., 401)` if missing.
- Sets headers: `Accept: application/vnd.github.v3+json`, `Authorization: Bearer <token>`, `User-Agent: <app>-GitHub-Connector` (rename per app — GitHub requires a UA).
- Reads `X-RateLimit-Limit/Remaining/Reset` from every response and returns `{ data, rateLimit }`.

### 4.2 API routes

All routes follow the same pattern: call connector → on `GitHubError` return `{ error, rateLimit }` with matching status → on other errors return 500.

| Route file | Method | Purpose |
|---|---|---|
| `src/app/api/github/status/route.ts` | `GET` | Liveness — `{ connected, login?, rateLimit?, error? }`. Returns 200 if connected, 503 otherwise. |
| `src/app/api/github/user/route.ts` | `GET` | Authenticated user profile. |
| `src/app/api/github/repos/route.ts` | `GET` | List repos. **NEW**: `POST` to create a repo (§7). |
| `src/app/api/github/repos/[owner]/[repo]/tree/route.ts` | `GET` | `?branch=main` — recursive tree. |
| `src/app/api/github/repos/[owner]/[repo]/contents/[...path]/route.ts` | `GET` | `?ref=<branch>` — single file content. |

> **Note on Next 15**: route params are async (`params: Promise<{ owner, repo }>`). Always `await params` before destructuring.

### 4.3 `src/components/github-browser.tsx` — the UI

Single client component. Self-contained: tracks its own connection state, repo list, branch, tree, expanded folders, open file tabs, and search filter. Polls `/api/github/status` on mount, then `/api/github/repos`, then user-driven loads.

Sections inside the file:
1. **Connection bar** — green/red banner from `/api/github/status`.
2. **Selector bar** — `<select>` of repos, `<input>` for branch (auto-filled from `default_branch`), Load button. **NEW**: a "+ New Repo" button (§7).
3. **Tree pane** — flat list from `git/trees?recursive=1` is folded into a nested `TreeNode` structure client-side via `buildTree()`; renders recursively with depth-based padding.
4. **File viewer** — tab strip + `<pre>` content. `atob()` the base64 from `/contents`.
5. **Project linking + ingest** *(Mycelium-specific — strip if not needed)* — buttons that POST to `/api/projects/[id]/repo` and `/api/projects/[id]/github-ingest`. These are not part of the portable integration.

State & data flow (no external state library required):
- `useEffect` on mount → `/api/github/status` → if connected, call `loadRepos()`.
- Selecting a repo → auto-set `branch` to its `default_branch`.
- "Load" button → `/api/github/repos/{o}/{r}/tree?branch=...` → `setTreeItems` → `buildTree` → auto-expand first level.
- Click file → `/api/github/repos/{o}/{r}/contents/{...path}?ref=<branch>` → `atob(content)` → push tab.

### 4.4 (Optional) Mounting in a tab switcher

Mycelium adds a tab in `view-switcher.tsx` and renders `<GitHubBrowser />` on that tab. In the target app, mount it wherever appropriate:

```tsx
import { GitHubBrowser } from "@/components/github-browser";

// somewhere in your page:
<GitHubBrowser />
```

The `projectId` prop is optional — pass `null`/omit if your app has no project concept. The link/ingest buttons render only when `projectId` is truthy.

---

## 5. Step-by-step integration checklist (for the implementing agent)

1. Add `GITHUB_PAT` to `.env.local`. Restart `next dev`.
2. Create `src/lib/github.ts` — copy from Mycelium verbatim, change the `User-Agent` string to `"<NewApp>-GitHub-Connector"`. Add `createRepo()` (§7).
3. Create the five API route files under `src/app/api/github/...`. Add `POST` handler to `repos/route.ts` (§7).
4. Create `src/components/github-browser.tsx` — copy from Mycelium. **Strip** the project-linking and ingest sections (`linkRepoToProject`, `ingestRepo`, the `linkedRepo`/`ingestResult` state, the `projectId` prop) if the target app has no project concept. Add the "+ New Repo" button + dialog (§7).
5. Mount `<GitHubBrowser />` in the page or tab where it should appear.
6. Hit `/api/github/status` in a browser — should return `{ connected: true, login: "<your-user>" }`.
7. Open the UI — repos should populate; pick one; Load should show the tree; click a file to view it.

If `/api/github/status` returns 503 with `"GITHUB_PAT is not configured"`, the env file isn't being read — confirm `.env.local` is at the project root and the dev server was restarted.

---

## 6. Error handling & rate limits

- All API routes propagate the GitHub status code (401 = bad token, 404 = no access / typo, 403 = rate limit or scope, 422 = validation on create).
- Rate limit object is passed through on every response so the UI can show "X / 5000 requests remaining" if desired.
- The unauthenticated rate limit is 60/hr; authenticated PAT is 5000/hr. The connector always uses the PAT, so 5000/hr is the practical ceiling.

---

## 7. NEW — Create repo from the UI

This is **not in Mycelium today**. Add it as part of the port.

### 7.1 Connector function

Append to `src/lib/github.ts`:

```ts
export interface CreateRepoInput {
  name: string;                 // required — repo slug
  description?: string;
  private?: boolean;            // default false
  auto_init?: boolean;          // default true → creates initial commit + README
  gitignore_template?: string;  // e.g. "Node"
  license_template?: string;    // e.g. "mit"
}

/** Create a new repository owned by the authenticated user */
export async function createRepo(input: CreateRepoInput) {
  const token = getToken();
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Mycelium-GitHub-Connector",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? "",
      private: input.private ?? false,
      auto_init: input.auto_init ?? true,
      gitignore_template: input.gitignore_template,
      license_template: input.license_template,
    }),
  });

  const rateLimit: GitHubRateLimit = {
    limit: Number(res.headers.get("X-RateLimit-Limit") || 0),
    remaining: Number(res.headers.get("X-RateLimit-Remaining") || 0),
    reset: Number(res.headers.get("X-RateLimit-Reset") || 0),
  };

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { message?: string }).message || res.statusText;
    throw new GitHubError(message, res.status, rateLimit);
  }

  const data = (await res.json()) as GitHubRepo;
  return { data, rateLimit };
}
```

> To create under an **organization** instead of the user, swap the URL to `/orgs/{org}/repos` and add an `org` field to `CreateRepoInput`.

### 7.2 API route — extend `repos/route.ts`

Add a `POST` handler alongside the existing `GET`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { listRepos, createRepo, GitHubError } from "@/lib/github";

export async function GET() { /* existing code */ }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const { data, rateLimit } = await createRepo({
      name: body.name,
      description: body.description,
      private: body.private,
      auto_init: body.auto_init ?? true,
    });
    return NextResponse.json({ repo: data, rateLimit }, { status: 201 });
  } catch (err) {
    if (err instanceof GitHubError) {
      return NextResponse.json(
        { error: err.message, rateLimit: err.rateLimit },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

### 7.3 UI — "+ New Repo" button

Add to `github-browser.tsx`:

**State:**
```ts
const [showCreate, setShowCreate] = useState(false);
const [newRepoName, setNewRepoName] = useState("");
const [newRepoDesc, setNewRepoDesc] = useState("");
const [newRepoPrivate, setNewRepoPrivate] = useState(true);
const [creating, setCreating] = useState(false);
```

**Handler:**
```ts
const createNewRepo = useCallback(async () => {
  if (!newRepoName.trim()) return;
  setCreating(true);
  setError(null);
  try {
    const res = await fetch("/api/github/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newRepoName.trim(),
        description: newRepoDesc.trim(),
        private: newRepoPrivate,
        auto_init: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to create repo");
      return;
    }
    // Refresh list, auto-select the new repo, close dialog
    await loadRepos();
    setSelectedRepo(data.repo.full_name);
    setBranch(data.repo.default_branch || "main");
    setShowCreate(false);
    setNewRepoName("");
    setNewRepoDesc("");
  } catch {
    setError("Failed to create repo");
  } finally {
    setCreating(false);
  }
}, [newRepoName, newRepoDesc, newRepoPrivate, loadRepos]);
```

**Button** — drop next to the Load button in the selector bar:
```tsx
<button
  onClick={() => setShowCreate(true)}
  disabled={!connected}
  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
  title="Create a new repository"
>
  + New Repo
</button>
```

**Dialog** — minimal modal (replace with shadcn `<Dialog>` if available):
```tsx
{showCreate && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="w-96 rounded-lg border bg-background p-6 shadow-xl">
      <h2 className="mb-4 text-lg font-semibold">Create new repository</h2>

      <label className="block text-sm">Name</label>
      <input
        autoFocus
        value={newRepoName}
        onChange={(e) => setNewRepoName(e.target.value)}
        placeholder="my-new-repo"
        className="mb-3 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
      />

      <label className="block text-sm">Description (optional)</label>
      <input
        value={newRepoDesc}
        onChange={(e) => setNewRepoDesc(e.target.value)}
        className="mb-3 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
      />

      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={newRepoPrivate}
          onChange={(e) => setNewRepoPrivate(e.target.checked)}
        />
        Private
      </label>

      <div className="flex justify-end gap-2">
        <button
          onClick={() => setShowCreate(false)}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Cancel
        </button>
        <button
          onClick={createNewRepo}
          disabled={creating || !newRepoName.trim()}
          className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create"}
        </button>
      </div>
    </div>
  </div>
)}
```

### 7.4 Required PAT permission for create

Fine-grained token: **Repository → Administration: Read and write** (in addition to Contents). Without this, the POST returns `403 Resource not accessible by personal access token`.

Classic PAT: `repo` scope is sufficient.

---

## 8. What to copy vs. what is Mycelium-specific

| Layer | Portable? | Notes |
|---|---|---|
| `src/lib/github.ts` | **Yes** — copy verbatim, change `User-Agent` string. | Add `createRepo()`. |
| `src/app/api/github/**` | **Yes** — copy verbatim. | Extend `repos/route.ts` with `POST`. |
| `src/components/github-browser.tsx` | **Mostly** — strip project linking + ingest. | Keep tree, file viewer, search, tabs. |
| `src/app/api/projects/[id]/repo` | **No** | Mycelium-only (DynamoDB project record). |
| `src/app/api/projects/[id]/github-ingest` | **No** | Mycelium-only (Memgraph + Voyage embedding). |
| `src/lib/github-ingest.ts` | **No** | Mycelium-only (graph ingestion). |

---

## 9. Env keys to copy — final list

```bash
# .env.local in the target app
GITHUB_PAT=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

That's it. One key. The integration is fully self-contained — no AWS, no DB, no external services beyond api.github.com.

If the new app needs **Create repo** to work, ensure the PAT has `Administration: Read and write` (fine-grained) or the `repo` scope (classic).
