Story: {{storyId}} — {{title}}
Acceptance criteria:
{{bulletedList}}

Touch points (edit only these):
{{globs}}

Sibling stories in this wave are editing the following paths — do NOT touch:
{{siblingGlobs}}

PROJECT BASELINE — a working scaffold is ALREADY in place:
- The working directory is the cloned & customized boilerplate (Pipeline v2
  Phase 1 — Next.js 16 / SST / Vite / etc., as the operator picked).
- `package.json`, `tsconfig.json`, `src/`, framework config files all exist
  AND are already wired. The project compiles and builds today.
- BMAD may already be installed at `_bmad/` (if the operator enabled it).
- A `plan.md` lives at the repo root — it's the operator-facing plan
  document, not a stray file.
- Do NOT run `npm create vite`, `npx create-next-app`, `tsc --init`, or any
  other scaffolding command. They will conflict with the existing setup.
- Do NOT scaffold to `/tmp` and copy files back — this race-conditions with
  sibling stories and overwrites their work.
- BUILD on top of the existing structure. Add files inside `src/` (or
  wherever the touch-point globs point). Edit existing files where the AC
  requires it. Don't re-create what's already there.

Context (pre-digested):
{{contextDigest}}

Rubric highlights relevant to this story:
{{rubricExcerpt}}

Effort: {{effortKeyword}}

DISCOVERY (Story A.6):
- The context digest above contains the project tree, plan summary, and adjacent files. You do NOT need to re-discover.
- Do NOT run `ls`, `find`, `tree`, or `Bash cat` on the project directory.
- Do NOT spawn Task / Agent / Explore subagents — your context already contains everything they would surface.
- Read at most the files you intend to modify. Do them in ONE message with parallel Read calls.

VERIFICATION (Story A.6):
- Do NOT Read a file you just Wrote or Edited — those tools error when they fail; their silent return IS the verification.
- Do NOT run `npm run dev` / `node --check` / `node --input-type=module` for ad-hoc syntax checks. The project's runtime command is in <run_command> below; downstream test/build gates catch real regressions.
- Visual tests at `<projectDir>/visual-tests.md` are the contract — your code must make each entry pass at runtime.

<run_command>
{{runCommand}}
</run_command>

Implement this story per your spec. Remember: declare blockers BEFORE editing, not after.

Return <DEV_RESULT> block when done.
