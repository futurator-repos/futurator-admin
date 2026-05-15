/**
 * AST Extract — deterministic structural facts via tree-sitter
 *
 * Reads a list of file paths and emits a JSON document describing
 * functions, classes, imports, and call sites. Feeds the COMPILER
 * agent as `<ground_truth>` so it doesn't have to re-derive structure
 * from the diff, and feeds graph-sync.mjs so we can MERGE :Function /
 * :Class / :Import nodes alongside the file-level :Node entities.
 *
 * Usage:
 *   node ast-extract.mjs --root /home/ubuntu/projects/X --files src/a.ts,src/b.tsx
 *   echo "src/a.ts\nsrc/b.tsx" | node ast-extract.mjs --root /path --stdin
 *   node ast-extract.mjs --root /path --diff-manifest "A src/a.ts\nM src/b.tsx\nD old.ts"
 *
 * Output: single JSON object on stdout (see SCHEMA below).
 *
 * Languages: TypeScript (.ts, .tsx), JavaScript (.js, .jsx, .mjs, .cjs).
 * Other extensions are skipped with a `skipReason` entry.
 *
 * Errors:
 *   - Per-file parse errors are caught + reported in the per-file entry,
 *     they do NOT abort the whole run. Best-effort by design — Compiler
 *     can fall through to its old behaviour when facts are missing.
 *   - Missing tree-sitter grammars print a stderr warning and the script
 *     exits 0 with an empty `files` array.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Slice C — directories the brownfield scan should never descend into.
// Kept narrow: deps, build output, test fixtures, wiki, AST cache.
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.vercel',
  '.sst',
  'knowledge',
  '.mycelium',
  '.claude',
  'public',
]);

// ── SCHEMA ──────────────────────────────────────────────────────────────
//
// {
//   "generatedAt": "ISO-8601",
//   "root": "/absolute/working/dir",
//   "fileCount": number,
//   "skipped": [{ path, reason }],
//   "files": [
//     {
//       "path": "src/game/dino.ts",       // relative to root
//       "language": "typescript",
//       "lineCount": number,
//       "imports": [
//         { "source": "./types", "specifiers": ["Dino", "Obstacle"], "line": 1 }
//       ],
//       "functions": [
//         {
//           "name": "applyGravity",
//           "kind": "function" | "method" | "arrow" | "generator",
//           "exported": boolean,
//           "params": ["dino", "dt"],
//           "line": number,
//           "endLine": number,
//           "className"?: "Dino"             // present when kind === "method"
//         }
//       ],
//       "classes": [
//         { "name": "Dino", "extends": "Entity" | null, "line": number, "endLine": number }
//       ],
//       "calls": [
//         { "callee": "Math.max", "fromFunction": "applyGravity" | null, "line": number }
//       ],
//       "parseError"?: "string"
//     }
//   ]
// }

// ── Language detection ──────────────────────────────────────────────────

function languageForExtension(ext) {
  switch (ext) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    default:
      return null;
  }
}

// ── Tree-sitter setup ───────────────────────────────────────────────────

let Parser;
let tsLangs = null;
let jsLang = null;

async function loadParsers() {
  try {
    Parser = (await import('tree-sitter')).default;
  } catch (err) {
    console.error(
      `[ast-extract] tree-sitter not installed (${err.message}). ` +
        `Run \`cd /opt/futurator-daemon && npm install\` on the host.`,
    );
    return false;
  }

  try {
    const TS = (await import('tree-sitter-typescript')).default;
    tsLangs = { typescript: TS.typescript, tsx: TS.tsx };
  } catch (err) {
    console.error(`[ast-extract] tree-sitter-typescript missing: ${err.message}`);
  }

  try {
    const JS = (await import('tree-sitter-javascript')).default;
    jsLang = JS;
  } catch (err) {
    console.error(`[ast-extract] tree-sitter-javascript missing: ${err.message}`);
  }

  return !!(Parser && (tsLangs || jsLang));
}

function languageObjectFor(language) {
  switch (language) {
    case 'typescript':
      return tsLangs?.typescript ?? null;
    case 'tsx':
      return tsLangs?.tsx ?? null;
    case 'javascript':
    case 'jsx':
      return jsLang ?? null;
    default:
      return null;
  }
}

// ── Tree walking helpers ────────────────────────────────────────────────

/**
 * Recursive descent over a tree-sitter syntax tree, invoking the visitor
 * for every node. Tree-sitter Node SDK doesn't ship a built-in walker, so
 * we use the cursor API.
 */
function walk(rootNode, visit) {
  const cursor = rootNode.walk();
  function descend() {
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      do {
        descend();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
  descend();
}

/** Get the identifier name child of a node by field name, with fallback. */
function nameOf(node) {
  return (
    node.childForFieldName('name')?.text ??
    node.descendantsOfType('identifier')[0]?.text ??
    node.descendantsOfType('property_identifier')[0]?.text ??
    null
  );
}

/** True if the parent (or grandparent) of `node` is an export statement. */
function isExported(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'export_statement' || p.type === 'export_default_declaration') {
      return true;
    }
    if (
      p.type === 'program' ||
      p.type === 'statement_block' ||
      p.type === 'class_body'
    ) {
      return false;
    }
    p = p.parent;
  }
  return false;
}

/** Extract parameter names from a `formal_parameters` node. */
function paramNamesFrom(paramsNode) {
  if (!paramsNode) return [];
  const out = [];
  for (const child of paramsNode.namedChildren) {
    // tree-sitter param node shapes: required_parameter, optional_parameter,
    // identifier, rest_pattern. Field 'pattern' or 'name' usually holds the
    // identifier.
    const id =
      child.childForFieldName('pattern') ??
      child.childForFieldName('name') ??
      child;
    out.push(id.text);
  }
  return out;
}

/** Find the nearest enclosing function/method that contains `node`. */
function enclosingFunctionName(node) {
  let p = node.parent;
  while (p) {
    if (
      p.type === 'function_declaration' ||
      p.type === 'method_definition' ||
      p.type === 'generator_function_declaration' ||
      p.type === 'arrow_function' ||
      p.type === 'function_expression'
    ) {
      // For arrow functions assigned to consts, the name is on the parent declarator.
      if (p.type === 'arrow_function' || p.type === 'function_expression') {
        const declarator = p.parent;
        if (declarator?.type === 'variable_declarator') {
          return declarator.childForFieldName('name')?.text ?? null;
        }
        return null;
      }
      if (p.type === 'method_definition') {
        return p.childForFieldName('name')?.text ?? null;
      }
      return p.childForFieldName('name')?.text ?? null;
    }
    p = p.parent;
  }
  return null;
}

// ── Per-file extraction ─────────────────────────────────────────────────

function extractFromTree(tree) {
  const imports = [];
  const functions = [];
  const classes = [];
  const calls = [];

  walk(tree.rootNode, (node) => {
    switch (node.type) {
      // Imports — `import { X } from 'source'` and `import 'side-effect'`
      case 'import_statement': {
        const sourceNode = node.descendantsOfType('string')[0];
        const source = sourceNode
          ? sourceNode.text.slice(1, -1) // strip quotes
          : null;
        const specifiers = node
          .descendantsOfType('import_specifier')
          .map((n) => n.childForFieldName('name')?.text)
          .filter(Boolean);
        // Default imports: `import X from 'src'`
        const defaultImport = node.descendantsOfType('identifier').find((id) => {
          // identifier directly under the import_clause that isn't inside named_imports
          let p = id.parent;
          while (p && p.type !== 'import_statement') {
            if (p.type === 'named_imports' || p.type === 'namespace_import') {
              return false;
            }
            p = p.parent;
          }
          return p?.type === 'import_statement';
        });
        if (defaultImport) specifiers.unshift(defaultImport.text);
        if (source) {
          imports.push({
            source,
            specifiers,
            line: node.startPosition.row + 1,
          });
        }
        break;
      }

      // Function declarations
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? null;
        if (!name) break;
        functions.push({
          name,
          kind: node.type === 'generator_function_declaration' ? 'generator' : 'function',
          exported: isExported(node),
          params: paramNamesFrom(node.childForFieldName('parameters')),
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // Arrow functions / function expressions bound to a const/let/var
      case 'arrow_function':
      case 'function_expression': {
        const declarator = node.parent;
        if (declarator?.type !== 'variable_declarator') break;
        const name = declarator.childForFieldName('name')?.text ?? null;
        if (!name) break;
        const declStmt = declarator.parent?.parent ?? declarator.parent;
        functions.push({
          name,
          kind: 'arrow',
          exported: isExported(declStmt ?? declarator),
          params: paramNamesFrom(node.childForFieldName('parameters')),
          line: declarator.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // Class methods
      case 'method_definition': {
        const name = node.childForFieldName('name')?.text ?? null;
        if (!name) break;
        // Walk up to find the containing class for the className field.
        let cls = node.parent;
        while (cls && cls.type !== 'class_declaration' && cls.type !== 'class') {
          cls = cls.parent;
        }
        functions.push({
          name,
          kind: 'method',
          exported: cls ? isExported(cls) : false,
          params: paramNamesFrom(node.childForFieldName('parameters')),
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          className: cls?.childForFieldName('name')?.text ?? null,
        });
        break;
      }

      // Class declarations
      case 'class_declaration': {
        const name = node.childForFieldName('name')?.text ?? null;
        if (!name) break;
        // extends X — the heritage clause / class_heritage holds the parent name
        let extendsName = null;
        const heritage = node.descendantsOfType('class_heritage')[0];
        if (heritage) {
          const idn =
            heritage.descendantsOfType('identifier')[0] ??
            heritage.descendantsOfType('type_identifier')[0];
          extendsName = idn?.text ?? null;
        }
        classes.push({
          name,
          extends: extendsName,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // Call expressions — capture callee text + enclosing function name
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (!fn) break;
        // For `obj.method(...)`, fn.text gives the dotted form. For bare
        // `foo(...)` it's the identifier. We keep whatever the source shows
        // so the COMPILER can see the actual call sites.
        const callee = fn.text;
        if (!callee || callee.length > 80) break;
        calls.push({
          callee,
          fromFunction: enclosingFunctionName(node),
          line: node.startPosition.row + 1,
        });
        break;
      }

      default:
        break;
    }
  });

  return { imports, functions, classes, calls };
}

// ── Arg parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    root: null,
    files: null, // array | null
    stdin: false,
    diffManifest: null,
    diffManifestFile: null,
    scan: false, // Slice C — full-repo walk mode
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--root':
        out.root = args[++i];
        break;
      case '--files':
        out.files = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--stdin':
        out.stdin = true;
        break;
      case '--diff-manifest':
        out.diffManifest = args[++i];
        break;
      case '--diff-manifest-file':
        out.diffManifestFile = args[++i];
        break;
      case '--scan':
        out.scan = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        console.error(`[ast-extract] unknown arg: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

/**
 * Walk `root` finding every source file with a supported extension. Skips
 * the common ignore-dirs above. Returns paths relative to `root`.
 */
async function scanRepoFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_EXCLUDE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.') continue; // hidden dirs
        await walk(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (languageForExtension(ext)) {
          out.push(relative(root, full));
        }
      }
    }
  }
  await walk(root);
  return out;
}

function printUsage() {
  console.log(`Usage:
  node ast-extract.mjs --root <dir> --files a.ts,b.tsx
  node ast-extract.mjs --root <dir> --diff-manifest "A a.ts\\nM b.tsx\\nD c.ts"
  node ast-extract.mjs --root <dir> --diff-manifest-file diff.txt
  echo "a.ts\\nb.tsx" | node ast-extract.mjs --root <dir> --stdin
`);
}

/** Pull file paths out of a git-diff-style manifest (A/M/D status prefix). */
function filesFromDiffManifest(manifest) {
  if (!manifest) return [];
  return manifest
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([AMD]|[RC]\d+)\s+(.+)$/);
      if (!m) return null;
      if (m[1] === 'D') return null; // skip deletes — file is gone
      return m[2];
    })
    .filter(Boolean);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.root) {
    console.error('[ast-extract] --root is required');
    printUsage();
    process.exit(2);
  }

  // Resolve file list from one of the input modes
  let files = args.files ?? null;
  if (!files && args.scan) {
    // Slice C — brownfield bootstrap: walk the whole working dir.
    files = await scanRepoFiles(args.root);
  }
  if (!files && args.stdin) {
    const text = await readStdin();
    files = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!files && args.diffManifest) {
    files = filesFromDiffManifest(args.diffManifest);
  }
  if (!files && args.diffManifestFile) {
    const text = readFileSync(args.diffManifestFile, 'utf-8');
    files = filesFromDiffManifest(text);
  }
  if (!files || files.length === 0) {
    // Nothing to extract — emit empty doc and exit 0 so the pipeline
    // step succeeds gracefully.
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          root: args.root,
          fileCount: 0,
          skipped: [],
          files: [],
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const parsersOk = await loadParsers();
  if (!parsersOk) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          root: args.root,
          fileCount: 0,
          skipped: files.map((p) => ({ path: p, reason: 'parsers-unavailable' })),
          files: [],
          error: 'tree-sitter not installed on host',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const skipped = [];
  const out = [];

  for (const relPath of files) {
    const ext = extname(relPath).toLowerCase();
    const language = languageForExtension(ext);
    if (!language) {
      skipped.push({ path: relPath, reason: `unsupported-ext:${ext || '(none)'}` });
      continue;
    }

    const abs = join(args.root, relPath);
    if (!existsSync(abs)) {
      skipped.push({ path: relPath, reason: 'not-found' });
      continue;
    }
    let s;
    try {
      s = await stat(abs);
    } catch (err) {
      skipped.push({ path: relPath, reason: `stat-error:${err.code ?? err.message}` });
      continue;
    }
    if (!s.isFile()) {
      skipped.push({ path: relPath, reason: 'not-a-file' });
      continue;
    }
    if (s.size > 1024 * 1024) {
      // 1 MB cap — parsing larger files is rarely useful and risks OOM
      skipped.push({ path: relPath, reason: `too-large:${s.size}` });
      continue;
    }

    let source;
    try {
      source = await readFile(abs, 'utf-8');
    } catch (err) {
      skipped.push({ path: relPath, reason: `read-error:${err.code ?? err.message}` });
      continue;
    }

    const lang = languageObjectFor(language);
    if (!lang) {
      skipped.push({ path: relPath, reason: `grammar-missing:${language}` });
      continue;
    }

    const parser = new Parser();
    parser.setLanguage(lang);
    let tree;
    try {
      tree = parser.parse(source);
    } catch (err) {
      out.push({
        path: relPath,
        language,
        lineCount: source.split('\n').length,
        imports: [],
        functions: [],
        classes: [],
        calls: [],
        parseError: err.message,
      });
      continue;
    }

    let facts;
    try {
      facts = extractFromTree(tree);
    } catch (err) {
      out.push({
        path: relPath,
        language,
        lineCount: source.split('\n').length,
        imports: [],
        functions: [],
        classes: [],
        calls: [],
        parseError: `extract-failed:${err.message}`,
      });
      continue;
    }

    out.push({
      path: relPath,
      language,
      lineCount: source.split('\n').length,
      ...facts,
    });
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    root: args.root,
    fileCount: out.length,
    skipped,
    files: out,
  };
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

main().catch((err) => {
  console.error('[ast-extract] fatal:', err.message);
  if (err.stack) console.error(err.stack);
  // Non-zero exit so the shell step records the failure, but still write a
  // minimal JSON so downstream parsing doesn't blow up.
  try {
    process.stdout.write(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        fileCount: 0,
        skipped: [],
        files: [],
        error: err.message,
      }) + '\n',
    );
  } catch {
    // ignore
  }
  process.exit(1);
});
