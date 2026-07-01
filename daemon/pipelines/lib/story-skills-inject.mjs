// story-skills-inject.mjs — G2: Skills glue for P3 story-dev path.
//
// Combines three separate skills concerns into a minimal surface:
//
//   buildSkillsInjection  — ONE --append-system-prompt merging the lazy/facts
//                           base injection (subagent-start) with the skills
//                           PUSH bodies (F24 relevance-ranked SKILL.md bodies
//                           for THIS story). Single arg so Claude Code never
//                           sees two --append-system-prompt flags.
//
//   trackSkillActivations — post-spawn: scan stream-json for tool_use Skill
//                           events and write to .context/loaded-skills.json so
//                           the per-story commit trailer is non-empty.
//
//   buildStoryCommitFlags — read the populated loaded-skills file and emit the
//                           Skills-Used + Skills-Manifest-Sha commit flag bodies.
//
//   resetStorySkills      — per-story isolation: clear loaded-skills before a
//                           new spawn so the trailer reflects ONLY this story.
//
// KEY INVARIANT: this module NEVER throws. Every function is best-effort; on
// any unexpected error it returns the safe empty/zero value so the spawn path
// and the commit path are never blocked by optional enrichment.

import { buildInjection, claudeCodeAppendArgs } from '../../lib/subagent-start.mjs';
import { buildSkillsPushPrompt, selectPushedSkillNames } from '../../lib/skills-prompt.mjs';
import {
  buildSkillSourceLookup,
  readLoadedSkills,
  recordSkillActivation,
  resetLoadedSkills,
} from '../../lib/loaded-skills-tracker.mjs';
import { buildSkillsCommitFlags } from './commit-metadata.mjs';

/**
 * Build the combined --append-system-prompt spawn args for a story-dev agent.
 *
 * Merges TWO sources of injected guidance into ONE flag (Claude Code only
 * accepts the last --append-system-prompt when given multiple — so we must
 * join them here):
 *
 *   1. Base injection: lazy-dev rules, facts pack, active instincts
 *      (from subagent-start `buildInjection`).
 *   2. Skills PUSH prompt: top-N skill bodies ranked by relevance to THIS
 *      story's text, plus the flat tail list (from `buildSkillsPushPrompt`).
 *
 * Sections are separated by `\n\n---\n\n` so the model sees a clear visual
 * break between the two sources of guidance.
 *
 * Falls back gracefully:
 *   - If skills build fails → returns args with base injection only.
 *   - If both fail        → returns [].
 *   - Never throws.
 *
 * @param {{
 *   workingDir: string,
 *   storyText: string,
 *   p3Flags?: Record<string,string>,
 * }} opts
 * @returns {Promise<string[]>} spawn args: [] or ['--append-system-prompt', combined]
 */
export async function buildSkillsInjection({ workingDir, storyText, p3Flags }) {
  try {
    const baseText = buildInjection({ p3Flags });
    let skillsText = null;
    try {
      skillsText = await buildSkillsPushPrompt(workingDir, storyText);
    } catch {
      // skills push failed (no loadout, embed error, etc.) — use base only
    }
    // Record the PUSHED skills as this story's loaded set. PUSH-injected bodies
    // never fire a `Skill` tool_use event (the header tells the agent not to
    // re-open them), so trackSkillActivations can't see them — without this the
    // story's Skills-Used trailer + the forensic Skills tab would report zero
    // even though a curated set was applied. Best-effort; never blocks the spawn.
    try {
      const { pushed } = await selectPushedSkillNames(workingDir, storyText);
      if (pushed && pushed.length) {
        const sourceLookup = buildSkillSourceLookup(workingDir);
        for (const skillName of pushed) {
          try {
            recordSkillActivation({ workingDir, skillName, sourceLookup });
          } catch {
            // one bad name never blocks the rest
          }
        }
      }
    } catch {
      // pushed-skill recording is optional enrichment — never block injection
    }
    const parts = [baseText, skillsText].filter((s) => s && s.trim());
    const combined = parts.join('\n\n---\n\n');
    return claudeCodeAppendArgs(combined);
  } catch {
    // Total failure: return empty (no injection, caller continues unharmed)
    return [];
  }
}

/**
 * Parse a stream-json output buffer for `tool_use` events where
 * `name === 'Skill'` and record each activation to the project's
 * `.context/loaded-skills.json`.
 *
 * Supports both stream-json shapes emitted by Claude Code:
 *   • `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"<name>"}}]}}`
 *   • `{"type":"tool_use","name":"Skill","input":{"skill":"<name>"}}`
 *
 * Builds the source lookup ONCE per call (one manifest read regardless of how
 * many skills the agent activated). Never throws — best-effort enrichment.
 *
 * @param {{ workingDir: string, rawOutput: string }} opts
 * @returns {{ recorded: number }}
 */
export function trackSkillActivations({ workingDir, rawOutput }) {
  if (!workingDir || !rawOutput) return { recorded: 0 };

  // Build the manifest lookup once; fall back to empty map on any error.
  let sourceLookup;
  try {
    sourceLookup = buildSkillSourceLookup(workingDir);
  } catch {
    sourceLookup = new Map();
  }

  let recorded = 0;
  const lines = rawOutput.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // non-JSON log line — skip
    }

    /** @param {string} skillName */
    const tryRecord = (skillName) => {
      if (!skillName || typeof skillName !== 'string') return;
      try {
        const r = recordSkillActivation({ workingDir, skillName, sourceLookup });
        if (r.written) recorded++;
      } catch {
        // best-effort; never block
      }
    };

    // Pattern 1: assistant message with content blocks
    if (event.type === 'assistant') {
      const content = event.message?.content ?? [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_use' && block.name === 'Skill') {
          tryRecord(block.input?.skill);
        }
      }
    }

    // Pattern 2: top-level tool_use event
    if (event.type === 'tool_use' && event.name === 'Skill') {
      tryRecord(event.input?.skill);
    }
  }

  return { recorded };
}

/**
 * Read the populated `.context/loaded-skills.json` and build the
 * `Skills-Used:` + `Skills-Manifest-Sha:` commit flag bodies.
 *
 * Returns [] under prototype rigor (delegate to buildSkillsCommitFlags
 * which gate-checks the rigor). Never throws.
 *
 * @param {{ workingDir: string, rigor: string }} opts
 * @returns {string[]}
 */
export function buildStoryCommitFlags({ workingDir, rigor }) {
  try {
    const loadedSkills = readLoadedSkills(workingDir);
    return buildSkillsCommitFlags({ rigor, workingDir, loadedSkills });
  } catch {
    return [];
  }
}

/**
 * Read this story's loaded skills as `{skill, source}` refs for PERSISTENCE onto
 * the plan-spec-graph story row (the forensic Skills tab reads `row.loadedSkills`).
 * The commit trailer proves it in git; this makes it queryable in DynamoDB
 * without cloning the repo. Never throws; returns [] on any miss.
 *
 * @param {string} workingDir
 * @returns {Array<{skill: string, source: string}>}
 */
export function readStoryLoadedSkills(workingDir) {
  try {
    return readLoadedSkills(workingDir);
  } catch {
    return [];
  }
}

/**
 * Reset the per-story loaded-skills file so the next story's
 * `Skills-Used:` trailer reflects ONLY that story's activations.
 *
 * No-op when the file is absent. Never throws.
 *
 * @param {string} workingDir
 */
export function resetStorySkills(workingDir) {
  try {
    resetLoadedSkills(workingDir);
  } catch {
    // best-effort
  }
}
