/**
 * mcp-config.mjs — wire the Mycelium graph MCP server into agent spawns.
 *
 * The MCP server (`daemon/mcp/mycelium-mcp.mjs`) exposes read-only graph tools
 * (query_graph, get_node, neighbors, blast_radius, god_nodes, orphans,
 * shortest_path). It runs as a stdio subprocess of the agent — ON THE BOX, next
 * to Memgraph (bolt://localhost:7687) — so there is NO VPC/network barrier for
 * agents (that only ever applied to the browser/API).
 *
 * Gated behind `MYCELIUM_MCP=on` so deploying is a no-op until the operator
 * enables it. When on, `myceliumMcpSpawn` returns the `--mcp-config` arg + (for
 * allowlisted agents) the graph tools appended to their allowlist. The tools are
 * read-only, so adding them to any agent is safe; a failing MCP server is
 * non-fatal to the Claude CLI.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url)); // daemon/lib
const MYCELIUM_MCP_PATH = join(__dirname, '..', 'mcp', 'mycelium-mcp.mjs');
const CONFIG_PATH = join(__dirname, '..', 'mcp', 'mcp-config.generated.json');

export const MYCELIUM_TOOLS = [
  'query_graph',
  'get_node',
  'neighbors',
  'blast_radius',
  'god_nodes',
  'orphans',
  'shortest_path',
];

export const isMyceliumMcpEnabled = () => process.env.MYCELIUM_MCP === 'on';

let configWritten = false;
function ensureConfig() {
  // Re-check existence, not just the in-process latch: a redeploy can delete the
  // untracked generated file, so regenerate it on the next spawn instead of crashing.
  if (configWritten && existsSync(CONFIG_PATH)) return CONFIG_PATH;
  const cfg = {
    mcpServers: {
      mycelium: {
        command: process.execPath,
        args: [MYCELIUM_MCP_PATH],
        env: { MEMGRAPH_URI: process.env.MEMGRAPH_URI || 'bolt://localhost:7687' },
      },
    },
  };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  configWritten = true;
  return CONFIG_PATH;
}

/**
 * Spawn additions to give an agent the graph tools. No-op unless MYCELIUM_MCP=on.
 *
 * @param {string|undefined} existingAllowedTools - the agent's current allowlist
 * @returns {{ args: string[], allowedTools: string|undefined }}
 */
export function myceliumMcpSpawn(existingAllowedTools) {
  if (!isMyceliumMcpEnabled()) return { args: [], allowedTools: existingAllowedTools };
  const path = ensureConfig();
  const toolNames = MYCELIUM_TOOLS.map((t) => `mcp__mycelium__${t}`).join(',');
  // Only EXTEND an existing allowlist; agents without one run permissively
  // (bypassPermissions), where --mcp-config alone makes the tools available.
  const allowedTools = existingAllowedTools ? `${existingAllowedTools},${toolNames}` : existingAllowedTools;
  return { args: ['--mcp-config', path], allowedTools };
}
