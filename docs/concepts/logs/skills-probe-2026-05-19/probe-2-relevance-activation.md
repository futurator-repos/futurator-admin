# Probe 2: relevance-based activation in non-interactive `claude -p`

**Date:** 2026-05-19
**CLI:** `claude --version` → `2.1.144 (Claude Code)`
**Working dir:** `/tmp/skills-probe-clean`
**Setup:** Single skill vendored at `.claude/skills/canvas-design/SKILL.md` (11939 bytes, fetched from `https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/SKILL.md`).
**Command:**

```bash
claude -p --setting-sources project --output-format stream-json --verbose \
  "I need to design a poster. Walk me through your approach in 3 bullets. Do not write code."
```

## Key findings (with stream-json evidence)

### 1. System init confirms auto-discovery

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/private/tmp/skills-probe-clean",
  "tools": ["Task", "Bash", "Read", "Skill", "Write", ...],
  "slash_commands": ["canvas-design", "update-config", "debug", ...],
  "skills":         ["canvas-design", "update-config", "debug", ...],
  "model": "claude-opus-4-7[1m]"
}
```

`canvas-design` is in **both** the `slash_commands` array and the `skills` array. Claude Code scanned `<cwd>/.claude/skills/*/SKILL.md` at session-start and registered the skill automatically.

### 2. The model autonomously invoked the skill (no `/canvas-design` slash command needed)

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01EbfYDg3XjgLFs5sCTAHvSc",
        "name": "Skill",
        "input": { "skill": "canvas-design" }
      }
    ]
  }
}
```

The agent saw the prompt mentioned "design a poster" → matched the skill's frontmatter `description` ("use this skill when the user asks to create a poster, piece of art, design...") → invoked the built-in `Skill` tool with `{skill: 'canvas-design'}`.

### 3. The full SKILL.md body was loaded as a `user`-role message

The `Skill` tool's result was a `tool_result` block followed by the entire `canvas-design/SKILL.md` content injected as a user-role message (visible in the stream-json — ~12KB block starting "Base directory for this skill: /private/tmp/skills-probe-clean/.claude/skills/canvas-design — These are instructions for creating design philosophies..."). The agent then continued the conversation with this content in context.

## Conclusions

- **Auto-discovery: YES**, for `.claude/skills/<name>/SKILL.md` in cwd, in non-interactive `claude -p` mode.
- **Auto-activation: YES**, via Claude Code's built-in `Skill` tool. No CLI flag, no slash command, no `--append-system-prompt` needed.
- **Trigger: frontmatter `description` matched against prompt content.** Match decision made by the model.
- **`Skill` tool is a first-class built-in tool** alongside Read/Write/Bash etc.

## Implications for Epic 2

The original plan stands. Stories 2.1–2.3 ship as designed. **No pivot to story 2.2-fallback** (manual `--append-system-prompt` injection) is needed.

Bonus: because activation is by built-in `Skill` tool, the daemon's `loadedSkills[]` tracking in Epic 4 has a clean signal source — count `tool_use` events with `name: "Skill"` per agent invocation. The forensic record of which skills actually got used per story falls out for free.

## Probe 3: confirmed without project-source override

```bash
claude -p --output-format stream-json --verbose \
  "List the skills available in this directory. One short line."
```

Output (skills array from init):

```json
"skills":["canvas-design","update-config","debug","simplify","batch",
         "fewer-permission-prompts","loop","schedule","claude-api"]
```

`canvas-design` is still first — no `--setting-sources` flag required. This matches how the daemon's `runAgent()` will spawn `claude -p` in production (no special flags beyond `--allowedTools`, `--model`, `--max-turns`, `--append-system-prompt`).
