/**
 * mycelium-mcp.test.mjs — Story 4.1. The MCP server scaffold: query_graph wraps
 * search-cascade; get_node + neighbors return structured results; the tool
 * registry + dispatcher are transport-agnostic.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_DEFS,
  dispatchTool,
  queryGraph,
  getNode,
  neighbors,
} from '../mycelium-mcp.mjs';
import { makeMcpSession } from './helpers/fake-mcp-graph.mjs';

const session = () =>
  makeMcpSession({
    projectId: 'pacman1',
    nodes: [
      { id: 'code/src--hub.ts', kind: 'file', title: 'hub.ts', centrality: 0.9, community: 0 },
      { id: 'code/src--leaf.ts', kind: 'file', title: 'leaf.ts' },
      { id: 'tbl/Scores', kind: 'table', title: 'Scores' },
    ],
    edges: [
      { from: 'code/src--leaf.ts', to: 'code/src--hub.ts', type: 'IMPORTS' },
      { from: 'code/src--hub.ts', to: 'tbl/Scores', type: 'READS' },
    ],
  });

describe('Mycelium-MCP scaffold (Story 4.1)', () => {
  it('exposes the three foundational tools in the registry', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['query_graph', 'get_node', 'neighbors']));
    // every tool carries a JSON input schema with required fields
    for (const t of TOOL_DEFS) {
      expect(t.inputSchema.type).toBe('object');
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });

  it('query_graph wraps search-cascade and shapes the structured result', async () => {
    const fakeCascade = async (projectId, question, workingDir, opts) => {
      expect(projectId).toBe('pacman1');
      expect(question).toBe('where is auth');
      expect(opts.maxLayer).toBe(4);
      return {
        graphResults: [{ nodeId: 'code/src--auth.ts', similarity: 0.8 }],
        wikiArticles: [{ nodeId: 'code/src--auth.ts', title: 'auth.ts', purpose: 'Login flow' }],
        grepMatches: [{ matchCount: 3 }],
        sourceFiles: [{ path: 'src/auth.ts', size: 1200 }],
      };
    };
    const res = await queryGraph(
      { question: 'where is auth', projectId: 'pacman1' },
      { cascade: fakeCascade },
    );
    expect(res.graphResults).toHaveLength(1);
    expect(res.wikiArticles[0].purpose).toBe('Login flow');
    expect(res.grepMatchCount).toBe(3);
    expect(res.fallbackUsed).toBe(false);
  });

  it('query_graph flags fallbackUsed when the cascade returns no graph hits (cold Memgraph)', async () => {
    const coldCascade = async () => ({ graphResults: [], grepMatches: [{ matchCount: 1 }], sourceFiles: [] });
    const res = await queryGraph({ question: 'x', projectId: 'pacman1' }, { cascade: coldCascade });
    expect(res.fallbackUsed).toBe(true);
  });

  it('get_node returns the node with its incident degree, or null when absent', async () => {
    const s = session();
    const hub = await getNode(s, { nodeId: 'code/src--hub.ts', projectId: 'pacman1' });
    expect(hub).toMatchObject({ kind: 'file', title: 'hub.ts', centrality: 0.9, community: 0 });
    expect(hub.degree).toBe(2); // leaf imports it, it reads Scores
    expect(await getNode(s, { nodeId: 'nope', projectId: 'pacman1' })).toBeNull();
  });

  it('neighbors lists adjacent nodes by edge type and respects direction', async () => {
    const s = session();
    const out = await neighbors(s, { nodeId: 'code/src--hub.ts', projectId: 'pacman1', dir: 'out' });
    expect(out).toEqual([{ type: 'READS', id: 'tbl/Scores', kind: 'table', title: 'Scores' }]);
    const incoming = await neighbors(s, { nodeId: 'code/src--hub.ts', projectId: 'pacman1', dir: 'in' });
    expect(incoming.map((n) => n.id)).toEqual(['code/src--leaf.ts']);
  });

  it('dispatchTool routes by name and rejects unknown tools', async () => {
    const s = session();
    const node = await dispatchTool('get_node', { nodeId: 'tbl/Scores', projectId: 'pacman1' }, { session: s });
    expect(node.kind).toBe('table');
    await expect(dispatchTool('nope', {}, { session: s })).rejects.toThrow(/Unknown tool/);
  });
});
