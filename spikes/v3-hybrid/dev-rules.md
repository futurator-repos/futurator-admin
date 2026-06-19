# DEV-RULES-v1 — minimum guidelines for dev subagents

This file is operator policy. `run-spike.sh` reads it and injects it into every dev
subagent's prompt via the workflow's `args`. The subagents keep full freedom in _how_
they implement; these are the few rules we then VERIFY deterministically on disk.

1. **STAMP.** The FIRST line of every source file you write must be exactly:
   `// @v3-stamp story=<STORY_ID> rules=DEV-RULES-v1`
   (substitute your own story id for `<STORY_ID>`; nothing may precede this line).

2. **SCOPE.** Write only your one declared source file. Never create, edit, or read any
   `*.test.*` or `*.spec.*` file. (None exist in your worktree — do not add one.)

3. **CONTRACT-FIRST.** Implement to the contract + acceptance criteria, never to a test.

> The stamp is intentionally trivial. Its purpose is not the stamp itself — it is to
> prove that a rule placed in the JS script (a) reaches every subagent in the swarm and
> (b) can be checked for compliance from outside the agent, on the artifact it produced.
