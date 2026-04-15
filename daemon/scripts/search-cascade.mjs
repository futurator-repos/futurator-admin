/**
 * 4-Layer Search Cascade
 * Story MY-5.2
 *
 * Cascading search strategy for agent context acquisition:
 *   Layer 1: GraphRAG (semantic + structural via Memgraph)
 *   Layer 2: Wiki articles (compiled knowledge for top nodes)
 *   Layer 3: Grep (precision code search via ripgrep)
 *   Layer 4: Raw file read (full source of most relevant files)
 *
 * Each layer's output feeds the next layer's targeting.
 *
 * CLI Usage:
 *   node search-cascade.mjs --project spyhunter --query "OAuth login" \
 *     --working-dir /home/ubuntu/projects/spyhunter --layer 4 --json
 *
 * Module Usage:
 *   import { searchCascade } from './search-cascade.mjs';
 *   const result = await searchCascade('spyhunter', 'auth flow', '/path/to/project');
 */

import { graphSearch } from './graph-search.mjs';
import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

// ── Arg parser ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (arg === '--query' && argv[i + 1]) args.query = argv[++i];
    else if (arg === '--working-dir' && argv[i + 1]) args.workingDir = argv[++i];
    else if (arg === '--top-k' && argv[i + 1]) args.topK = parseInt(argv[++i], 10);
    else if (arg === '--hops' && argv[i + 1]) args.hops = parseInt(argv[++i], 10);
    else if (arg === '--min-similarity' && argv[i + 1]) args.minSimilarity = parseFloat(argv[++i]);
    else if (arg === '--max-source-files' && argv[i + 1]) args.maxSourceFiles = parseInt(argv[++i], 10);
    else if (arg === '--layer' && argv[i + 1]) args.maxLayer = parseInt(argv[++i], 10);
    else if (arg === '--grep-pattern' && argv[i + 1]) {
      args.grepPatterns = args.grepPatterns || [];
      args.grepPatterns.push(argv[++i]);
    }
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function printUsage() {
  console.error(`Usage: node search-cascade.mjs --project <id> --query "<text>" --working-dir <path> [options]

Options:
  --project <id>            Project ID (required)
  --query "<text>"          Search query (required)
  --working-dir <path>      Project root directory (required)
  --top-k <n>               GraphRAG top-K results (default: 10)
  --hops <n>                GraphRAG traversal depth (default: 2)
  --min-similarity <f>      Min cosine similarity (default: 0.6)
  --max-source-files <n>    Max files to read in Layer 4 (default: 5)
  --layer <n>               Stop after layer N (1-4, default: 4)
  --grep-pattern <pattern>  Additional grep pattern (repeatable)
  --verbose                 Print debug info to stderr
  --json                    Machine-readable JSON output`);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a nodeId from wiki format to a source file path.
 * Wiki convention: "code/src--components--auth.tsx" → "src/components/auth.tsx"
 */
function nodeIdToSourcePath(nodeId) {
  if (!nodeId.startsWith('code/')) return null;
  // Strip "code/" prefix, then strip trailing ".md" if present,
  // and replace "--" with "/"
  let path = nodeId.slice(5);
  if (path.endsWith('.md')) path = path.slice(0, -3);
  return path.replace(/--/g, '/');
}

/**
 * Safely read a file, returning null if it doesn't exist.
 */
async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse frontmatter from a markdown file.
 * Returns { frontmatter: {}, body: string }.
 */
function parseMarkdownFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // Parse simple arrays [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((s) => s.trim());
      }
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: match[2] };
}

/**
 * Extract [[wikilinks]] from markdown body text.
 */
function extractWikilinks(text) {
  const links = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    links.push(m[1]);
  }
  return links;
}

/**
 * Run a shell command and return stdout. Returns empty string on failure.
 */
function shellExec(cmd, cwd, timeoutMs = 10000) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// ── Layer implementations ───────────────────────────────────────────

/**
 * Layer 1: GraphRAG — semantic + structural search via Memgraph.
 */
async function layer1GraphRAG(projectId, query, opts, dbg) {
  dbg('Layer 1: GraphRAG search...');
  const startMs = Date.now();

  try {
    const results = await graphSearch(projectId, query, {
      topK: opts.topK || 10,
      hops: opts.hops || 2,
      minSimilarity: opts.minSimilarity || 0.6,
      verbose: opts.verbose,
    });

    dbg(`Layer 1 complete: ${results.length} nodes in ${Date.now() - startMs}ms`);
    return results;
  } catch (err) {
    dbg(`Layer 1 error: ${err.message}`);
    return [];
  }
}

/**
 * Layer 2: Wiki articles — read compiled knowledge for top graph nodes.
 */
async function layer2Wiki(graphResults, knowledgeDir, dbg) {
  dbg(`Layer 2: Reading wiki articles for ${graphResults.length} nodes...`);
  const startMs = Date.now();
  const articles = [];

  for (const node of graphResults) {
    const articlePath = join(knowledgeDir, `${node.nodeId}.md`);
    const content = await safeReadFile(articlePath);

    if (!content) {
      dbg(`Layer 2: Missing article for ${node.nodeId} (stale node?)`);
      continue;
    }

    const { frontmatter, body } = parseMarkdownFrontmatter(content);
    const wikilinks = extractWikilinks(body);

    // Extract sections
    const sections = {};
    const sectionRegex = /^## (.+)$/gm;
    let match;
    const sectionStarts = [];
    while ((match = sectionRegex.exec(body)) !== null) {
      sectionStarts.push({ name: match[1], index: match.index + match[0].length });
    }
    for (let i = 0; i < sectionStarts.length; i++) {
      const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : body.length;
      const sectionBody = body.slice(sectionStarts[i].index, end).trim();
      // Remove the next "## " header if captured
      sections[sectionStarts[i].name] = sectionBody.replace(/^## .+$/m, '').trim();
    }

    // Derive source file path for code-type articles
    const sourcePath = node.type === 'code' ? nodeIdToSourcePath(node.nodeId) : null;

    articles.push({
      nodeId: node.nodeId,
      type: node.type,
      phase: node.phase,
      title: node.title,
      similarity: node.similarity,
      frontmatter,
      purpose: sections['Purpose'] || '',
      dependencies: sections['Dependencies'] || '',
      dependents: sections['Dependents'] || '',
      missingSignals: sections['Missing Signals'] || '',
      wikilinks,
      sourcePath,
    });
  }

  dbg(`Layer 2 complete: ${articles.length} articles read in ${Date.now() - startMs}ms`);
  return articles;
}

/**
 * Layer 3: Grep — precision code search via ripgrep on identified source files.
 */
function layer3Grep(wikiArticles, query, workingDir, grepPatterns, dbg) {
  dbg('Layer 3: Grep precision search...');
  const startMs = Date.now();

  // Collect source file paths from code-type articles
  const sourceFiles = wikiArticles
    .filter((a) => a.sourcePath)
    .map((a) => a.sourcePath);

  // Build grep patterns from query + any explicit patterns
  const patterns = [
    ...query.split(/\s+/).filter((w) => w.length > 3), // words longer than 3 chars
    ...(grepPatterns || []),
  ];

  if (patterns.length === 0 || sourceFiles.length === 0) {
    dbg('Layer 3: No patterns or source files to grep');
    return [];
  }

  const grepMatches = [];

  // Try ripgrep first, fall back to grep
  const grepCmd = shellExec('which rg', workingDir) ? 'rg' : 'grep -rn';

  for (const pattern of patterns) {
    // Escape special regex characters for safety
    const safePattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let targets;
    if (sourceFiles.length <= 20) {
      // If few files, target them directly
      targets = sourceFiles.join(' ');
    } else {
      // Otherwise, grep the whole tree
      targets = '.';
    }

    const cmd = grepCmd === 'rg'
      ? `rg --no-heading -n -C 3 --max-count 50 "${safePattern}" ${targets} 2>/dev/null || true`
      : `grep -rn -C 3 --max-count=50 "${safePattern}" ${targets} 2>/dev/null || true`;

    const output = shellExec(cmd, workingDir);
    if (output) {
      const lines = output.split('\n').slice(0, 200); // Cap output
      grepMatches.push({
        pattern,
        matchCount: lines.filter((l) => !l.startsWith('--')).length,
        output: lines.join('\n'),
      });
    }
  }

  dbg(`Layer 3 complete: ${grepMatches.length} patterns, ${grepMatches.reduce((s, m) => s + m.matchCount, 0)} matches in ${Date.now() - startMs}ms`);
  return grepMatches;
}

/**
 * Layer 4: Raw file read — full source for the most relevant files.
 */
async function layer4Read(wikiArticles, grepMatches, workingDir, maxSourceFiles, dbg) {
  dbg('Layer 4: Reading full source files...');
  const startMs = Date.now();

  // Score files by relevance: wiki similarity + grep match density
  const fileScores = new Map();

  // Score from wiki articles (higher similarity = more relevant)
  for (const article of wikiArticles) {
    if (article.sourcePath) {
      const current = fileScores.get(article.sourcePath) || 0;
      fileScores.set(article.sourcePath, current + (article.similarity || 0.5));
    }
  }

  // Score from grep match density
  for (const gm of grepMatches) {
    // Extract file paths from grep output lines
    const fileMatches = new Map();
    for (const line of gm.output.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const file = line.slice(0, colonIdx);
        fileMatches.set(file, (fileMatches.get(file) || 0) + 1);
      }
    }
    for (const [file, count] of fileMatches) {
      const current = fileScores.get(file) || 0;
      fileScores.set(file, current + count * 0.1);
    }
  }

  // Sort by score descending, take top N
  const topFiles = [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSourceFiles || 5);

  const sourceFiles = [];
  for (const [filePath, score] of topFiles) {
    const fullPath = join(workingDir, filePath);
    const content = await safeReadFile(fullPath);
    if (!content) {
      dbg(`Layer 4: File not found: ${filePath}`);
      continue;
    }

    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      fileStat = null;
    }

    sourceFiles.push({
      path: filePath,
      fullPath,
      size: fileStat?.size || content.length,
      lastModified: fileStat?.mtime?.toISOString() || null,
      content,
      score,
    });
  }

  dbg(`Layer 4 complete: ${sourceFiles.length} files read in ${Date.now() - startMs}ms`);
  return sourceFiles;
}

// ── Main cascade function ───────────────────────────────────────────

/**
 * Execute the 4-layer search cascade.
 *
 * @param {string} projectId - The project to search within.
 * @param {string} query - Natural language search query.
 * @param {string} workingDir - Project root directory on disk.
 * @param {object} [opts] - Cascade options.
 * @param {number} [opts.topK=10] - GraphRAG top-K results.
 * @param {number} [opts.hops=2] - GraphRAG traversal depth.
 * @param {number} [opts.minSimilarity=0.6] - Min cosine similarity.
 * @param {string[]} [opts.grepPatterns] - Additional grep patterns.
 * @param {number} [opts.maxSourceFiles=5] - Max files to read in full.
 * @param {number} [opts.maxLayer=4] - Stop after this layer (1-4).
 * @param {boolean} [opts.verbose=false] - Debug output to stderr.
 * @returns {Promise<{graphResults: Array, wikiArticles: Array, grepMatches: Array, sourceFiles: Array}>}
 */
export async function searchCascade(projectId, query, workingDir, opts = {}) {
  const {
    topK = 10,
    hops = 2,
    minSimilarity = 0.6,
    grepPatterns = [],
    maxSourceFiles = 5,
    maxLayer = 4,
    verbose = false,
  } = opts;

  const dbg = verbose ? (msg) => console.error(`[search-cascade] ${msg}`) : () => {};
  const knowledgeDir = join(resolve(workingDir), 'knowledge');

  const result = {
    graphResults: [],
    wikiArticles: [],
    grepMatches: [],
    sourceFiles: [],
  };

  // Layer 1: GraphRAG
  result.graphResults = await layer1GraphRAG(projectId, query, { topK, hops, minSimilarity, verbose }, dbg);

  if (result.graphResults.length === 0) {
    dbg('Layer 1 returned no results. Cascade complete (empty).');
    return result;
  }

  if (maxLayer < 2) return result;

  // Layer 2: Wiki articles
  result.wikiArticles = await layer2Wiki(result.graphResults, knowledgeDir, dbg);

  if (maxLayer < 3) return result;

  // Layer 3: Grep
  result.grepMatches = layer3Grep(result.wikiArticles, query, workingDir, grepPatterns, dbg);

  if (maxLayer < 4) return result;

  // Layer 4: Raw file read
  result.sourceFiles = await layer4Read(result.wikiArticles, result.grepMatches, workingDir, maxSourceFiles, dbg);

  return result;
}

// ── CLI entry point ─────────────────────────────────────────────────

const isCLI = process.argv[1] &&
  (process.argv[1].endsWith('search-cascade.mjs') ||
   process.argv[1].endsWith('search-cascade'));

if (isCLI) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.project || !args.query || !args.workingDir) {
    printUsage();
    process.exit(1);
  }

  try {
    const result = await searchCascade(args.project, args.query, args.workingDir, {
      topK: args.topK,
      hops: args.hops,
      minSimilarity: args.minSimilarity,
      grepPatterns: args.grepPatterns,
      maxSourceFiles: args.maxSourceFiles,
      maxLayer: args.maxLayer,
      verbose: args.verbose,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Human-readable output with layer separators
      console.log('=== Layer 1: GraphRAG Results ===');
      console.log(`Found ${result.graphResults.length} nodes:`);
      for (const r of result.graphResults) {
        console.log(`  [${r.similarity.toFixed(3)}] ${r.type}/${r.title} (maturity: ${r.maturity}) — ${r.relationships.length} relationships`);
      }

      if (result.wikiArticles.length > 0) {
        console.log('\n=== Layer 2: Wiki Articles ===');
        console.log(`Read ${result.wikiArticles.length} articles:`);
        for (const a of result.wikiArticles) {
          console.log(`  ${a.nodeId}: ${a.purpose.slice(0, 100)}...`);
        }
      }

      if (result.grepMatches.length > 0) {
        console.log('\n=== Layer 3: Grep Matches ===');
        for (const g of result.grepMatches) {
          console.log(`  Pattern "${g.pattern}": ${g.matchCount} matches`);
        }
      }

      if (result.sourceFiles.length > 0) {
        console.log('\n=== Layer 4: Source Files ===');
        for (const f of result.sourceFiles) {
          console.log(`  ${f.path} (${f.size} bytes, score: ${f.score.toFixed(2)})`);
        }
      }
    }
  } catch (err) {
    console.error(`[search-cascade] ERROR: ${err.message}`);
    process.exit(1);
  }
}
