/**
 * Bootstrap Dependencies — Import/Dependency Extraction for Brownfield Projects
 * Story MY-6.2
 *
 * Parses import/require/from statements in source files, maps them to wiki article
 * slugs, and creates [[wikilinks]] in Dependencies/Dependents sections.
 * Generates knowledge/system/dependency-map.md with the full import graph.
 * Detects circular dependencies.
 *
 * Usage:
 *   node bootstrap-deps.mjs --dir /home/ubuntu/projects/spyhunter
 *   node bootstrap-deps.mjs --dir /path --json
 *
 * Exports:
 *   extractDependencies(knowledgeDir, workingDir) — main entry point
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative, dirname, extname, resolve, sep } from 'path';

// ── Helpers ──

function log(level, msg, data = {}) {
  const prefix = {
    info: '\x1b[36mINFO\x1b[0m',
    warn: '\x1b[33mWARN\x1b[0m',
    error: '\x1b[31mERROR\x1b[0m',
    debug: '\x1b[90mDEBG\x1b[0m',
  };
  const ts = new Date().toISOString();
  const extra = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] ${prefix[level] || level} [bootstrap-deps] ${msg}${extra}`);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function toSlug(filePath) {
  return filePath.replace(/\//g, '--').replace(/\\/g, '--');
}

function slugToArticlePath(slug) {
  return `code/${slug}`;
}

// ── Import Parsing ──

/**
 * Extract all import statements from a source file.
 * Returns array of { source, kind, names } objects.
 */
function parseImports(content, ext) {
  const imports = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // ES import ... from '...'
    const importFromRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importFromRegex.exec(content)) !== null) {
      const names = parseImportNames(m[1]);
      imports.push({ source: m[2], kind: 'import', names });
    }

    // require('...')
    const requireRegex = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = requireRegex.exec(content)) !== null) {
      imports.push({ source: m[2], kind: 'require', names: [m[1]] });
    }

    // Bare require (no assignment)
    const bareRequireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = bareRequireRegex.exec(content)) !== null) {
      if (!imports.find(i => i.source === m[1])) {
        imports.push({ source: m[1], kind: 'require', names: [] });
      }
    }

    // Side-effect imports: import '...'
    const sideEffectRegex = /import\s+['"]([^'"]+)['"]\s*;?/g;
    while ((m = sideEffectRegex.exec(content)) !== null) {
      if (!imports.find(i => i.source === m[1])) {
        imports.push({ source: m[1], kind: 'side-effect', names: [] });
      }
    }

    // Re-exports: export { ... } from '...'
    const reExportRegex = /export\s*\{[^}]*\}\s*from\s+['"]([^'"]+)['"]/g;
    while ((m = reExportRegex.exec(content)) !== null) {
      if (!imports.find(i => i.source === m[1])) {
        imports.push({ source: m[1], kind: 're-export', names: [] });
      }
    }

    // export * from '...'
    const starReExportRegex = /export\s*\*\s*from\s+['"]([^'"]+)['"]/g;
    while ((m = starReExportRegex.exec(content)) !== null) {
      if (!imports.find(i => i.source === m[1])) {
        imports.push({ source: m[1], kind: 'star-re-export', names: [] });
      }
    }
  }

  if (ext === '.py') {
    // from X import Y, Z
    const fromImportRegex = /^from\s+([\w.]+)\s+import\s+([\w,\s*]+)/gm;
    let m;
    while ((m = fromImportRegex.exec(content)) !== null) {
      const names = m[2].split(',').map(n => n.trim()).filter(Boolean);
      imports.push({ source: m[1], kind: 'python-from', names });
    }

    // import X, Y
    const importRegex = /^import\s+([\w.,\s]+)/gm;
    while ((m = importRegex.exec(content)) !== null) {
      const modules = m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      for (const mod of modules) {
        imports.push({ source: mod, kind: 'python-import', names: [mod] });
      }
    }
  }

  if (ext === '.css' || ext === '.scss') {
    // @import '...'
    const cssImportRegex = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?/g;
    let m;
    while ((m = cssImportRegex.exec(content)) !== null) {
      imports.push({ source: m[1], kind: 'css-import', names: [] });
    }

    // @use '...'
    const useRegex = /@use\s+['"]([^'"]+)['"]/g;
    while ((m = useRegex.exec(content)) !== null) {
      imports.push({ source: m[1], kind: 'css-use', names: [] });
    }
  }

  return imports;
}

/**
 * Parse import name clause to extract symbol names.
 */
function parseImportNames(nameClause) {
  const names = [];
  const trimmed = nameClause.trim();

  // Default import: import Foo from ...
  if (/^\w+$/.test(trimmed)) {
    return [trimmed];
  }

  // Namespace: import * as Foo from ...
  const nsMatch = trimmed.match(/^\*\s+as\s+(\w+)$/);
  if (nsMatch) return [nsMatch[1]];

  // Default + named: import Foo, { Bar, Baz } from ...
  const comboMatch = trimmed.match(/^(\w+)\s*,\s*\{([^}]*)\}$/);
  if (comboMatch) {
    names.push(comboMatch[1]);
    for (const n of comboMatch[2].split(',')) {
      const name = n.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    return names;
  }

  // Named only: { Bar, Baz }
  const namedMatch = trimmed.match(/^\{([^}]*)\}$/);
  if (namedMatch) {
    for (const n of namedMatch[1].split(',')) {
      const name = n.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    return names;
  }

  return [trimmed];
}

// ── Path Resolution ──

/**
 * Load tsconfig.json path aliases if available.
 */
function loadPathAliases(workingDir) {
  const aliases = {};
  const tsconfigPath = join(workingDir, 'tsconfig.json');

  if (existsSync(tsconfigPath)) {
    try {
      let raw = readFileSync(tsconfigPath, 'utf-8');
      // Strip comments (simple approach for jsonc)
      raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(raw);
      const paths = config?.compilerOptions?.paths || {};
      const baseUrl = config?.compilerOptions?.baseUrl || '.';

      for (const [alias, targets] of Object.entries(paths)) {
        // Convert glob pattern to prefix: "@/*" -> "@/"
        const aliasPrefix = alias.replace('/*', '/');
        const targetPrefix = (targets[0] || '').replace('/*', '/');
        aliases[aliasPrefix] = join(baseUrl, targetPrefix);
      }
    } catch (err) {
      log('warn', 'Could not parse tsconfig.json for path aliases', { error: err.message });
    }
  }

  return aliases;
}

/**
 * Classify an import as internal (project file) or external (npm/stdlib).
 */
function classifyImport(source, ext) {
  // Relative paths are always internal
  if (source.startsWith('.') || source.startsWith('/')) return 'internal';

  // Python stdlib and pip packages
  if (['.py'].includes(ext)) {
    // Simple heuristic: if it contains a dot, might be relative
    // Otherwise likely a package
    return 'external';
  }

  // CSS imports that don't start with . are typically from node_modules
  if (['.css', '.scss'].includes(ext)) {
    if (source.startsWith('~')) return 'external';
    if (!source.startsWith('.')) return 'external';
    return 'internal';
  }

  // Node.js: non-relative imports are npm packages or Node built-ins
  return 'external';
}

/**
 * Resolve an import source to an absolute file path within the project.
 */
function resolveImportSource(source, importingFile, workingDir, knownFiles, pathAliases) {
  const importingDir = dirname(importingFile);

  // Apply path aliases
  for (const [alias, target] of Object.entries(pathAliases)) {
    if (source.startsWith(alias)) {
      source = source.replace(alias, target);
      break;
    }
  }

  // Resolve relative path
  let resolvedRel;
  if (source.startsWith('.')) {
    resolvedRel = join(importingDir, source).replace(/\\/g, '/');
  } else if (source.startsWith('/')) {
    resolvedRel = source.slice(1); // Treat as relative to project root
  } else {
    // After alias resolution, might now be a relative path
    resolvedRel = source.replace(/\\/g, '/');
  }

  // Normalize: remove leading ./
  if (resolvedRel.startsWith('./')) resolvedRel = resolvedRel.slice(2);

  // Try exact match
  if (knownFiles.has(resolvedRel)) return resolvedRel;

  // Try adding extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.json'];
  for (const ext of extensions) {
    if (knownFiles.has(resolvedRel + ext)) return resolvedRel + ext;
  }

  // Try as directory with index file
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    const indexPath = `${resolvedRel}/index${ext}`;
    if (knownFiles.has(indexPath)) return indexPath;
  }

  return null;
}

/**
 * Attempt to resolve barrel exports.
 * If an import points to an index file that re-exports, trace to the actual source.
 */
function resolveBarrelExport(resolvedPath, workingDir, knownFiles) {
  const fullPath = join(workingDir, resolvedPath);
  const baseName = resolvedPath.split('/').pop() || '';

  // Only check index files
  if (!baseName.match(/^index\.[jt]sx?$/)) return [resolvedPath];

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const reExports = [];

    // export { ... } from './...'
    const reExportRegex = /export\s*(?:\{[^}]*\}|\*)\s*from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = reExportRegex.exec(content)) !== null) {
      const dir = dirname(resolvedPath);
      let target = join(dir, m[1]).replace(/\\/g, '/');
      if (target.startsWith('./')) target = target.slice(2);

      // Resolve the re-export target
      const resolved = resolveImportSource(m[1], resolvedPath, workingDir, knownFiles, {});
      if (resolved) {
        reExports.push(resolved);
      }
    }

    return reExports.length > 0 ? reExports : [resolvedPath];
  } catch {
    return [resolvedPath];
  }
}

// ── Cycle Detection ──

/**
 * Detect circular dependencies using DFS.
 * Returns array of cycle paths.
 */
function detectCycles(adjacencyMap) {
  const cycles = [];
  const visited = new Set();
  const inStack = new Set();
  const stack = [];

  function dfs(node) {
    if (inStack.has(node)) {
      // Found a cycle
      const cycleStart = stack.indexOf(node);
      if (cycleStart >= 0) {
        const cycle = [...stack.slice(cycleStart), node];
        cycles.push(cycle);
      }
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = adjacencyMap.get(node) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adjacencyMap.keys()) {
    dfs(node);
  }

  // Deduplicate cycles (normalize by sorting the cycle path)
  const seen = new Set();
  const uniqueCycles = [];
  for (const cycle of cycles) {
    const key = [...cycle].sort().join(' -> ');
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCycles.push(cycle);
    }
  }

  return uniqueCycles;
}

// ── Article Updating ──

/**
 * Update a wiki article's Dependencies, Dependents, and External Dependencies sections.
 * Preserves all other content.
 */
function updateArticleSections(articleContent, dependencies, dependents, externalDeps) {
  // Parse the article into sections
  const sections = parseArticleSections(articleContent);

  // Build new Dependencies section
  let depsContent;
  if (dependencies.length > 0) {
    depsContent = dependencies
      .map(d => `- [[${d.articleSlug}]] — ${d.description}`)
      .join('\n');
  } else {
    depsContent = '_No internal dependencies detected._';
  }

  // Build new Dependents section
  let dependentsContent;
  if (dependents.length > 0) {
    dependentsContent = dependents
      .map(d => `- [[${d.articleSlug}]] — ${d.description}`)
      .join('\n');
  } else {
    dependentsContent = '_No dependents detected._';
  }

  // Build External Dependencies section
  let externalContent = '';
  if (externalDeps.length > 0) {
    externalContent = '\n## External Dependencies\n\n' +
      externalDeps.map(d => `- \`${d.source}\``).join('\n') + '\n';
  }

  // Reconstruct the article
  sections['Dependencies'] = depsContent;
  sections['Dependents'] = dependentsContent;

  // Remove old External Dependencies if it was in sections
  delete sections['External Dependencies'];

  return rebuildArticle(sections, externalContent);
}

/**
 * Parse a markdown article into a map of section name -> content.
 * Preserves frontmatter separately.
 */
function parseArticleSections(content) {
  const sections = {};
  let frontmatter = '';
  let body = content;

  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    frontmatter = fmMatch[0];
    body = content.slice(fmMatch[0].length);
  }

  sections['__frontmatter__'] = frontmatter;

  // Split by ## headings
  const sectionRegex = /^## (.+)$/gm;
  let lastIndex = 0;
  let lastSection = '__preamble__';
  let m;

  const sectionOrder = [];

  while ((m = sectionRegex.exec(body)) !== null) {
    const sectionContent = body.slice(lastIndex, m.index).trim();
    sections[lastSection] = sectionContent;
    if (!sectionOrder.includes(lastSection)) sectionOrder.push(lastSection);

    lastSection = m[1].trim();
    lastIndex = m.index + m[0].length;
  }

  // Last section
  const lastContent = body.slice(lastIndex).trim();
  sections[lastSection] = lastContent;
  if (!sectionOrder.includes(lastSection)) sectionOrder.push(lastSection);

  sections['__order__'] = sectionOrder;
  return sections;
}

/**
 * Rebuild a markdown article from parsed sections.
 */
function rebuildArticle(sections, extraSections = '') {
  const order = sections['__order__'] || [];
  const frontmatter = sections['__frontmatter__'] || '';

  let result = frontmatter;

  for (const name of order) {
    if (name.startsWith('__')) continue;
    const content = sections[name] || '';

    if (name === '__preamble__' || name === '') {
      if (content) result += content + '\n\n';
    } else {
      result += `\n## ${name}\n\n${content}\n`;
    }
  }

  // Append extra sections (External Dependencies)
  if (extraSections) {
    result += extraSections;
  }

  return result;
}

// ── Dependency Map Generation ──

/**
 * Generate the knowledge/system/dependency-map.md article.
 */
function generateDependencyMap(
  knowledgeDir,
  adjacencyMap,
  reverseMap,
  cycles,
  stats
) {
  const dateStr = today();

  let fileListings = '';
  const sortedFiles = [...adjacencyMap.keys()].sort();

  for (const file of sortedFiles) {
    const deps = adjacencyMap.get(file) || [];
    const revDeps = reverseMap.get(file) || [];

    fileListings += `### ${file}\n\n`;
    if (deps.length > 0) {
      fileListings += '**Depends on:**\n';
      for (const d of deps) {
        fileListings += `- [[${d}]]\n`;
      }
    } else {
      fileListings += '_No dependencies._\n';
    }
    if (revDeps.length > 0) {
      fileListings += '\n**Depended on by:**\n';
      for (const d of revDeps) {
        fileListings += `- [[${d}]]\n`;
      }
    }
    fileListings += '\n';
  }

  let cycleSection = '';
  if (cycles.length > 0) {
    cycleSection = cycles
      .map((cycle, i) => `${i + 1}. ${cycle.join(' -> ')}`)
      .join('\n');
  } else {
    cycleSection = '_No circular dependencies detected._';
  }

  const content = `---
title: Dependency Map
type: system
phase: system
status: active
maturity: 0.5
created: ${dateStr}
updated: ${dateStr}
createdByEpic: bootstrap
createdByStory: bootstrap-deps
tags: [dependencies, import-graph, system]
---

## Purpose

Complete dependency graph for the project, generated by analyzing import/require
statements in all source files. This map shows which files depend on which,
enabling impact analysis and architectural understanding.

## Summary Statistics

- **Total files analyzed:** ${stats.totalFiles}
- **Total internal edges (dependencies):** ${stats.totalEdges}
- **Total external packages:** ${stats.externalPackages}
- **Circular dependencies detected:** ${cycles.length}
- **Unresolved imports:** ${stats.unresolvedImports}
- **Files with no dependencies:** ${stats.isolatedFiles}

## Full Dependency Listing

${fileListings}

## Circular Dependencies

${cycleSection}

## Unresolved Imports

${stats.unresolvedList.length > 0
    ? stats.unresolvedList.map(u => `- \`${u.source}\` in \`${u.file}\``).join('\n')
    : '_All imports resolved successfully._'
  }
`;

  const mapPath = join(knowledgeDir, 'system', 'dependency-map.md');
  writeFileSync(mapPath, content, 'utf-8');
  log('info', `Generated dependency-map.md`);
}

// ── Pipeline Event Emission ──

function emitEvent(event) {
  log('info', `Pipeline event: ${event.type}`, event);
}

// ── Main Dependency Extraction ──

/**
 * Main dependency extraction function.
 *
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {string} workingDir - Path to project root
 * @param {object} opts - Options
 * @returns {object} Extraction results
 */
export async function extractDependencies(knowledgeDir, workingDir, opts = {}) {
  const startTime = Date.now();

  log('info', 'Starting dependency extraction', { knowledgeDir, workingDir });

  // Load bootstrap manifest to know which articles exist
  const manifestPath = join(workingDir, '.mycelium', 'bootstrap-manifest.json');
  let manifest = { scannedFiles: [] };
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      log('warn', 'Could not read bootstrap manifest', { error: err.message });
    }
  }

  // Build lookup maps
  const sourceToSlug = new Map(); // sourcePath -> article slug (code/slug)
  const slugToSource = new Map(); // article slug -> sourcePath
  const knownFiles = new Set();   // all known relative source paths

  for (const entry of manifest.scannedFiles) {
    sourceToSlug.set(entry.sourcePath, entry.slug);
    slugToSource.set(entry.slug, entry.sourcePath);
    knownFiles.add(entry.sourcePath);
  }

  // Load path aliases from tsconfig.json
  const pathAliases = loadPathAliases(workingDir);
  if (Object.keys(pathAliases).length > 0) {
    log('info', `Loaded ${Object.keys(pathAliases).length} path alias(es) from tsconfig.json`);
  }

  // Parse all imports
  const fileDeps = new Map();       // sourcePath -> [{ resolved, source, kind }]
  const externalDepsMap = new Map(); // sourcePath -> [{ source }]
  const adjacencyMap = new Map();    // articleSlug -> [articleSlug] (internal deps)
  const reverseMap = new Map();      // articleSlug -> [articleSlug] (dependents)
  const unresolvedList = [];
  let totalEdges = 0;
  const externalPackages = new Set();

  for (const entry of manifest.scannedFiles) {
    const fullPath = join(workingDir, entry.sourcePath);
    const ext = extname(entry.sourcePath);

    let content;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      log('warn', `Cannot read source file: ${entry.sourcePath}`);
      continue;
    }

    const imports = parseImports(content, ext);
    const internalDeps = [];
    const externalDeps = [];

    for (const imp of imports) {
      const classification = classifyImport(imp.source, ext);

      if (classification === 'external') {
        externalDeps.push({ source: imp.source });
        externalPackages.add(imp.source.split('/')[0]); // Get base package name
        continue;
      }

      // Resolve internal import
      const resolved = resolveImportSource(
        imp.source, entry.sourcePath, workingDir, knownFiles, pathAliases
      );

      if (!resolved) {
        unresolvedList.push({ file: entry.sourcePath, source: imp.source });
        continue;
      }

      // Handle barrel exports
      const resolvedFiles = resolveBarrelExport(resolved, workingDir, knownFiles);

      for (const resolvedFile of resolvedFiles) {
        const targetSlug = sourceToSlug.get(resolvedFile);
        if (!targetSlug) {
          unresolvedList.push({ file: entry.sourcePath, source: imp.source, resolved: resolvedFile });
          continue;
        }

        internalDeps.push({
          resolvedFile,
          articleSlug: targetSlug,
          source: imp.source,
          names: imp.names || [],
        });

        // Build adjacency lists
        const fromSlug = entry.slug;
        if (!adjacencyMap.has(fromSlug)) adjacencyMap.set(fromSlug, []);
        if (!adjacencyMap.get(fromSlug).includes(targetSlug)) {
          adjacencyMap.get(fromSlug).push(targetSlug);
          totalEdges++;
        }

        if (!reverseMap.has(targetSlug)) reverseMap.set(targetSlug, []);
        if (!reverseMap.get(targetSlug).includes(fromSlug)) {
          reverseMap.get(targetSlug).push(fromSlug);
        }
      }
    }

    fileDeps.set(entry.sourcePath, internalDeps);
    externalDepsMap.set(entry.sourcePath, externalDeps);
  }

  log('info', `Parsed imports from ${manifest.scannedFiles.length} files`, {
    totalEdges,
    externalPackages: externalPackages.size,
    unresolved: unresolvedList.length,
  });

  // Detect circular dependencies
  const cycles = detectCycles(adjacencyMap);
  if (cycles.length > 0) {
    log('warn', `Detected ${cycles.length} circular dependency cycle(s)`);
  }

  // Update wiki articles with dependency edges
  let articlesUpdated = 0;
  for (const entry of manifest.scannedFiles) {
    const articlePath = join(knowledgeDir, 'code', `${toSlug(entry.sourcePath)}.md`);

    if (!existsSync(articlePath)) {
      log('warn', `Article not found: ${articlePath}`);
      continue;
    }

    const articleContent = readFileSync(articlePath, 'utf-8');
    const deps = fileDeps.get(entry.sourcePath) || [];
    const externals = externalDepsMap.get(entry.sourcePath) || [];
    const slug = entry.slug;
    const revDeps = reverseMap.get(slug) || [];

    // Build dependency descriptions
    const depDescriptions = deps.map(d => ({
      articleSlug: d.articleSlug,
      description: d.names.length > 0
        ? `imports ${d.names.slice(0, 3).map(n => `\`${n}\``).join(', ')}${d.names.length > 3 ? ' ...' : ''}`
        : `imported as \`${d.source}\``,
    }));

    // Deduplicate
    const seenDeps = new Set();
    const uniqueDeps = depDescriptions.filter(d => {
      if (seenDeps.has(d.articleSlug)) return false;
      seenDeps.add(d.articleSlug);
      return true;
    });

    // Build dependent descriptions
    const depSlugs = new Set();
    const dependentDescriptions = revDeps
      .filter(s => {
        if (depSlugs.has(s)) return false;
        depSlugs.add(s);
        return true;
      })
      .map(depSlug => {
        const depSource = slugToSource.get(depSlug) || depSlug;
        return {
          articleSlug: depSlug,
          description: `depends on this file`,
        };
      });

    // Update article
    const updatedContent = updateArticleSections(
      articleContent, uniqueDeps, dependentDescriptions, externals
    );

    writeFileSync(articlePath, updatedContent, 'utf-8');
    articlesUpdated++;
  }

  log('info', `Updated ${articlesUpdated} articles with dependency edges`);

  // Compute stats
  let isolatedFiles = 0;
  for (const entry of manifest.scannedFiles) {
    const slug = entry.slug;
    const hasDeps = (adjacencyMap.get(slug) || []).length > 0;
    const hasRevDeps = (reverseMap.get(slug) || []).length > 0;
    if (!hasDeps && !hasRevDeps) isolatedFiles++;
  }

  const stats = {
    totalFiles: manifest.scannedFiles.length,
    totalEdges,
    externalPackages: externalPackages.size,
    unresolvedImports: unresolvedList.length,
    isolatedFiles,
    unresolvedList: unresolvedList.slice(0, 50), // Limit for readability
    cycles: cycles.length,
  };

  // Generate dependency-map.md
  generateDependencyMap(knowledgeDir, adjacencyMap, reverseMap, cycles, stats);

  // Update index.md to include dependency-map
  updateIndexForDeps(knowledgeDir);

  // Append to log.md
  appendDepsLog(knowledgeDir, stats, Date.now() - startTime);

  // Emit completion event
  emitEvent({
    type: 'complete',
    stage: 'deps',
    filesProcessed: manifest.scannedFiles.length,
    edgesCreated: totalEdges,
    cycles: cycles.length,
    unresolvedImports: unresolvedList.length,
    durationMs: Date.now() - startTime,
  });

  return {
    totalEdges,
    articlesUpdated,
    cycles: cycles.length,
    externalPackages: externalPackages.size,
    unresolvedImports: unresolvedList.length,
    isolatedFiles,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Update knowledge/index.md to include the dependency-map article.
 */
function updateIndexForDeps(knowledgeDir) {
  const indexPath = join(knowledgeDir, 'index.md');
  if (!existsSync(indexPath)) return;

  let content = readFileSync(indexPath, 'utf-8');

  // Check if dependency-map is already listed
  if (content.includes('dependency-map')) return;

  // Add entry before the last empty line or at the end
  const newRow = `| Dependency Map | system | system | active | \`knowledge/system/dependency-map.md\` |`;

  if (content.includes('|-------|------|-------|--------|------|')) {
    // Find the table and append
    const lines = content.split('\n');
    const tableHeaderIdx = lines.findIndex(l => l.includes('|-------|'));
    if (tableHeaderIdx >= 0) {
      // Find the last non-empty table row
      let insertIdx = tableHeaderIdx + 1;
      while (insertIdx < lines.length && lines[insertIdx].startsWith('|')) {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, newRow);
      content = lines.join('\n');
    }
  } else {
    content += '\n' + newRow + '\n';
  }

  writeFileSync(indexPath, content, 'utf-8');
}

/**
 * Append dependency extraction record to knowledge/log.md.
 */
function appendDepsLog(knowledgeDir, stats, durationMs) {
  const logPath = join(knowledgeDir, 'log.md');
  if (!existsSync(logPath)) return;

  const existing = readFileSync(logPath, 'utf-8');
  const entry = `
### bootstrap-deps — ${new Date().toISOString()}

- **Files Analyzed:** ${stats.totalFiles}
- **Internal Dependencies (edges):** ${stats.totalEdges}
- **External Packages:** ${stats.externalPackages}
- **Circular Dependencies:** ${stats.cycles}
- **Unresolved Imports:** ${stats.unresolvedImports}
- **Isolated Files:** ${stats.isolatedFiles}
- **Duration:** ${(durationMs / 1000).toFixed(1)}s
`;

  writeFileSync(logPath, existing + entry, 'utf-8');
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);

  let workingDir = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
      case '--working-dir':
        workingDir = args[++i];
        break;
      case '--json':
        jsonOutput = true;
        break;
      case '--help':
        console.log(`
Usage: node bootstrap-deps.mjs --dir <path> [options]

Options:
  --dir <path>   Path to project root directory (must contain knowledge/ and .mycelium/)
  --json         Output results as JSON
  --help         Show this help message
`);
        process.exit(0);
    }
  }

  if (!workingDir) {
    console.error('Error: --dir is required');
    console.error('Usage: node bootstrap-deps.mjs --dir /path/to/project');
    process.exit(1);
  }

  const knowledgeDir = join(workingDir, 'knowledge');
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: knowledge/ directory not found at ${knowledgeDir}`);
    console.error('Run bootstrap-scan.mjs first to generate wiki articles.');
    process.exit(1);
  }

  try {
    const result = await extractDependencies(knowledgeDir, workingDir);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n=== Dependency Extraction Complete ===');
      console.log(`  Edges created:      ${result.totalEdges}`);
      console.log(`  Articles updated:   ${result.articlesUpdated}`);
      console.log(`  Circular deps:      ${result.cycles}`);
      console.log(`  External packages:  ${result.externalPackages}`);
      console.log(`  Unresolved imports: ${result.unresolvedImports}`);
      console.log(`  Isolated files:     ${result.isolatedFiles}`);
      console.log(`  Duration:           ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');
    }
  } catch (err) {
    console.error('Dependency extraction failed:', err.message);
    if (!jsonOutput) console.error(err.stack);
    process.exit(1);
  }
}

// Run if executed directly
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('bootstrap-deps.mjs') ||
  process.argv[1].endsWith('bootstrap-deps')
);

if (isDirectExecution) {
  main();
}
