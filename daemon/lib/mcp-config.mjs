/**
 * mcp-config.mjs — wire the Mycelium graph MCP server into agent spawns.
 *
 * The MCP server (`daemon/mcp/mycelium-mcp.mjs`) exposes read-only graph tools
 * (query_graph, get_node, neighbors, transitive_reach, get_file_symbols,
 * list_kind, dependency_subgraph, path_between, god_nodes, orphans,
 * shortest_path). It runs as a stdio subprocess of the agent and reads the
 * DynamoDB-backed GraphStore (Story S0.2, KD-1) with the host's per-server IAM
 * keys — no bolt, no VPC/network barrier, so it boots on ANY fleet host.
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
  'transitive_reach',
  'get_file_symbols',
  'list_kind',
  'dependency_subgraph',
  'path_between',
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
        // GraphStore (S0.2) targets: table names + region for the DynamoDB store.
        // When these resolve the store hits DynamoDB with the host's IAM keys;
        // absent, `createGraphStore` degrades to the in-memory store.
        env: {
          GRAPH_NODES_TABLE: process.env.GRAPH_NODES_TABLE || 'futurator-graph-nodes',
          GRAPH_EDGES_TABLE: process.env.GRAPH_EDGES_TABLE || 'futurator-graph-edges',
          AWS_REGION: process.env.AWS_REGION || 'eu-central-1',
        },
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
  return myceliumMcpSpawnForced(existingAllowedTools);
}

/**
 * Like `myceliumMcpSpawn` but NOT gated behind `MYCELIUM_MCP=on`. The dual-agent
 * comparison harness uses this to give Agent B the graph tools regardless of the
 * global flag — graph access IS the isolated variable under test there, so it
 * must not depend on a deploy-wide toggle.
 */
export function myceliumMcpSpawnForced(existingAllowedTools) {
  const path = ensureConfig();
  const toolNames = MYCELIUM_TOOLS.map((t) => `mcp__mycelium__${t}`).join(',');
  // Only EXTEND an existing allowlist; agents without one run permissively
  // (bypassPermissions), where --mcp-config alone makes the tools available.
  const allowedTools = existingAllowedTools ? `${existingAllowedTools},${toolNames}` : existingAllowedTools;
  return { args: ['--mcp-config', path], allowedTools };
}
