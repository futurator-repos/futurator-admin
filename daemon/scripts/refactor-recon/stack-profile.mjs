#!/usr/bin/env node
// stack-profile.mjs — Refactoring Scan Engine v2, the Stack Profile.
//
// Deterministic, ~0 LLM, PROVIDER/LANGUAGE-AGNOSTIC, MANIFEST+EXTENSION-DRIVEN.
// Answers "what IS this codebase" — languages, runtime, package manager, frameworks,
// UI, databases, build tools, monorepo shape, and a one-line human summary — so every
// downstream authority (architecture / infra / compliance) shares one substrate view.
//
// Detection is manifest-first (package.json/deps, requirements/pyproject, go.mod,
// Cargo.toml, Gemfile, composer.json, pom.xml/build.gradle) with an extension
// histogram for the language mix. It reads MANIFEST content only — never every file.
//
// USAGE: node stack-profile.mjs <repo> [--out file]

import fs from 'node:fs';
import path from 'node:path';

// ── Extension → language (grouped by language, not extension). ──
const EXT_LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyi': 'Python',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
  '.cs': 'C#',
  '.php': 'PHP',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++',
  '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C',
  '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'CSS', '.sass': 'CSS', '.less': 'CSS',
  '.dart': 'Dart',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.sql': 'SQL',
  '.lua': 'Lua',
  '.ex': 'Elixir', '.exs': 'Elixir',
  '.clj': 'Clojure', '.cljs': 'Clojure',
  '.hs': 'Haskell',
};

// language → runtime (used as the manifest-tiebreak + no-manifest fallback)
const LANG_RUNTIME = {
  TypeScript: 'node', JavaScript: 'node', Vue: 'node', Svelte: 'node', Astro: 'node',
  Python: 'python', Go: 'go', Ruby: 'ruby', Rust: 'rust',
  Java: 'jvm', Kotlin: 'jvm', Scala: 'jvm', Groovy: 'jvm',
  'C#': 'dotnet', PHP: 'php',
};

// node framework dep → friendly name (ordered: app-defining first, backend last, so the
// summary's primary framework is the one that characterizes the app).
const NODE_FRAMEWORKS = [
  { name: 'Next.js', dep: 'next', config: /(^|\/)next\.config\.[mc]?[jt]s$/ },
  { name: 'SvelteKit', dep: '@sveltejs/kit', config: /(^|\/)svelte\.config\.[mc]?[jt]s$/ },
  { name: 'Astro', dep: 'astro', config: /(^|\/)astro\.config\.[mc]?[jt]s$/ },
  { name: 'Angular', dep: '@angular/core' },
  { name: 'React', dep: 'react' },
  { name: 'Vue', dep: 'vue' },
  { name: 'Svelte', dep: 'svelte' },
  { name: 'NestJS', dep: '@nestjs/core' },
  { name: 'Express', dep: 'express' },
  { name: 'Hono', dep: 'hono' },
];
const FRAMEWORK_DEP = Object.fromEntries(NODE_FRAMEWORKS.map((f) => [f.name, f.dep]));

const WEB_FW = new Set(['Next.js', 'SvelteKit', 'Astro', 'Angular', 'React', 'Vue', 'Svelte', 'Django', 'Rails', 'Laravel']);
const API_FW = new Set(['NestJS', 'Express', 'Hono', 'Fastify', 'Flask', 'FastAPI', 'Gin', 'Spring']);

const ARCHETYPE_LABEL = {
  'web-app': 'web app', 'api-service': 'api service', cli: 'CLI', library: 'library',
  mobile: 'mobile app', desktop: 'desktop app', game: 'game', unknown: 'unknown',
};

function parseJSON(str) { try { return JSON.parse(str); } catch { return null; } }
function depMajor(range) { const m = String(range || '').match(/(\d+)/); return m ? m[1] : null; }

/**
 * Pure stack-profile builder.
 * @param {Array<{rel:string, content?:string}>} files — every file's rel path; content
 *   set for manifests (package.json, requirements.txt, pyproject.toml, go.mod,
 *   Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle, tailwind/next/vite/
 *   tsconfig, components.json).
 */
export function buildStackProfile(files = []) {
  const rels = files.map((f) => f.rel);
  const exists = (re) => rels.some((r) => re.test(r));
  const findContent = (re) => {
    const hits = files.filter((f) => re.test(f.rel) && typeof f.content === 'string');
    hits.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
    return hits.length ? hits[0].content : null;
  };

  // ── language histogram (by extension) ──
  const langCounts = new Map();
  let total = 0;
  for (const rel of rels) {
    const lang = EXT_LANG[path.extname(rel).toLowerCase()];
    if (!lang) continue;
    langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    total++;
  }
  const languages = [...langCounts.entries()]
    .map(([lang, n]) => ({ lang, files: n, pct: total ? Math.round((n / total) * 100) : 0 }))
    .sort((a, b) => b.files - a.files || a.lang.localeCompare(b.lang));
  const primaryLanguage = languages.length ? languages[0].lang : null;

  // ── manifests ──
  const pkgRaw = findContent(/(^|\/)package\.json$/);
  const pkg = pkgRaw ? parseJSON(pkgRaw) : null;
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) } : {};
  const hasDep = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const pyproject = findContent(/(^|\/)pyproject\.toml$/) || '';
  const requirements = findContent(/(^|\/)requirements\.txt$/) || '';
  const py = `${pyproject}\n${requirements}`;
  const gomod = findContent(/(^|\/)go\.mod$/) || '';
  const cargo = findContent(/(^|\/)Cargo\.toml$/) || '';
  const gemfile = findContent(/(^|\/)Gemfile$/) || '';
  const composerRaw = findContent(/(^|\/)composer\.json$/);
  const composer = composerRaw ? (parseJSON(composerRaw) || {}) : null;
  const composerDeps = composer ? Object.keys({ ...(composer.require || {}), ...(composer['require-dev'] || {}) }).join(' ') : '';
  const pom = findContent(/(^|\/)pom\.xml$/) || '';
  const gradle = findContent(/(^|\/)build\.gradle(\.kts)?$/) || '';
  const jvm = `${pom}\n${gradle}`;

  const hasPkg = pkgRaw != null || exists(/(^|\/)package\.json$/);
  const hasPy = pyproject || requirements || exists(/(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/);
  const hasGo = gomod || exists(/(^|\/)go\.mod$/);
  const hasCargo = cargo || exists(/(^|\/)Cargo\.toml$/);
  const hasGem = gemfile || exists(/(^|\/)Gemfile$/);
  const hasComposer = composer || exists(/(^|\/)composer\.json$/);
  const hasJvm = jvm.trim() || exists(/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/);

  // ── runtime (manifest candidates; primary-language breaks ties) ──
  const candidates = [];
  if (hasPkg) candidates.push('node');
  if (hasPy) candidates.push('python');
  if (hasGo) candidates.push('go');
  if (hasCargo) candidates.push('rust');
  if (hasGem) candidates.push('ruby');
  if (hasJvm) candidates.push('jvm');
  if (hasComposer) candidates.push('php');
  const langRuntime = LANG_RUNTIME[primaryLanguage] || null;
  let runtime = null;
  if (candidates.length) runtime = langRuntime && candidates.includes(langRuntime) ? langRuntime : candidates[0];
  else runtime = langRuntime;

  // ── package manager ──
  let packageManager = null;
  if (runtime === 'node') {
    const pmField = pkg && pkg.packageManager ? String(pkg.packageManager).split('@')[0] : null;
    if (pmField) packageManager = pmField;
    else if (exists(/(^|\/)pnpm-lock\.yaml$/)) packageManager = 'pnpm';
    else if (exists(/(^|\/)yarn\.lock$/)) packageManager = 'yarn';
    else if (exists(/(^|\/)bun\.lock(b)?$/)) packageManager = 'bun';
    else if (exists(/(^|\/)package-lock\.json$/)) packageManager = 'npm';
    else packageManager = 'npm';
  } else if (runtime === 'python') {
    packageManager = /\[tool\.poetry\]/.test(pyproject) ? 'poetry' : 'pip';
  } else if (runtime === 'rust') packageManager = 'cargo';
  else if (runtime === 'go') packageManager = 'go';
  else if (runtime === 'ruby') packageManager = 'bundler';
  else if (runtime === 'php') packageManager = 'composer';
  else if (runtime === 'jvm') packageManager = gradle.trim() ? 'gradle' : 'maven';

  // ── frameworks ──
  const frameworks = [];
  const addFw = (name) => { if (!frameworks.includes(name)) frameworks.push(name); };
  for (const f of NODE_FRAMEWORKS) {
    if (hasDep(f.dep) || (f.config && exists(f.config))) addFw(f.name);
  }
  if (/(^|=|>|<|~|\s)django\b/i.test(py)) addFw('Django');
  if (/(^|=|>|<|~|\s)flask\b/i.test(py)) addFw('Flask');
  if (/(^|=|>|<|~|\s)fastapi\b/i.test(py)) addFw('FastAPI');
  if (/\bgin-gonic\/gin\b/.test(gomod)) addFw('Gin');
  if (/\brails\b/i.test(gemfile)) addFw('Rails');
  if (/laravel\/framework/i.test(composerDeps)) addFw('Laravel');
  if (/spring-boot|springframework/i.test(jvm)) addFw('Spring');

  // ── UI ──
  const ui = [];
  const addUi = (name) => { if (!ui.includes(name)) ui.push(name); };
  if (hasDep('tailwindcss') || exists(/(^|\/)tailwind\.config\.[mc]?[jt]s$/)) addUi('Tailwind');
  if (exists(/(^|\/)components\.json$/)) addUi('shadcn/ui');
  if (hasDep('@mui/material') || hasDep('@material-ui/core')) addUi('MUI');
  if (hasDep('@chakra-ui/react')) addUi('Chakra');
  if (hasDep('styled-components')) addUi('styled-components');
  if (exists(/\.module\.(css|scss|sass|less)$/)) addUi('CSS Modules');

  // ── databases / ORMs ──
  const databases = [];
  const addDb = (name) => { if (!databases.includes(name)) databases.push(name); };
  if (hasDep('prisma') || hasDep('@prisma/client')) addDb('Prisma');
  if (hasDep('drizzle-orm')) addDb('Drizzle');
  if (hasDep('typeorm')) addDb('TypeORM');
  if (hasDep('sequelize')) addDb('Sequelize');
  if (hasDep('mongoose')) addDb('Mongoose');
  if (/\bsqlalchemy\b/i.test(py)) addDb('SQLAlchemy');
  if (/\b(activerecord|rails)\b/i.test(gemfile)) addDb('ActiveRecord');

  // ── build tools ──
  const buildTools = [];
  const addBt = (name) => { if (!buildTools.includes(name)) buildTools.push(name); };
  if (hasDep('vite') || exists(/(^|\/)vite\.config\.[mc]?[jt]s$/)) addBt('Vite');
  if (hasDep('webpack')) addBt('Webpack');
  if (hasDep('esbuild')) addBt('esbuild');
  if (hasDep('rollup')) addBt('Rollup');
  if (hasDep('tsup')) addBt('tsup');
  const scriptsStr = pkg && pkg.scripts ? Object.values(pkg.scripts).join(' ') : '';
  if (hasDep('turbopack') || /--turbo(pack)?\b/.test(scriptsStr)) addBt('Turbopack');

  // ── monorepo ──
  let monorepo = null;
  if (hasDep('turbo') || exists(/(^|\/)turbo\.json$/)) monorepo = 'turbo';
  else if (hasDep('nx') || exists(/(^|\/)nx\.json$/)) monorepo = 'nx';
  else if (exists(/(^|\/)pnpm-workspace\.yaml$/)) monorepo = 'pnpm-workspace';
  else if (exists(/(^|\/)lerna\.json$/)) monorepo = 'lerna';

  // ── archetype ──
  const hasHtml = langCounts.has('HTML');
  const hasReact = hasDep('react') || frameworks.includes('React');
  const hasVite = buildTools.includes('Vite');
  const hasNext = frameworks.includes('Next.js');
  const hasUI = ui.length > 0;
  const hasApiFw = frameworks.some((f) => API_FW.has(f)) || hasDep('fastify') || hasDep('koa');
  const hasWebFw = frameworks.some((f) => WEB_FW.has(f));
  const hasBin = !!(pkg && pkg.bin);
  const hasCliDep = ['commander', 'yargs', 'oclif', '@oclif/core', 'ink', 'inquirer'].some((d) => hasDep(d))
    || /\[project\.scripts\]|console_scripts/.test(py)
    || /\[\[bin\]\]/.test(cargo);
  const hasMainExports = !!(pkg && (pkg.main || pkg.exports)) || /\[lib\]/.test(cargo);
  const hasAppEntry = hasNext || hasVite || hasWebFw || hasApiFw || exists(/(^|\/)(index|app|main)\.(html|tsx|jsx)$/);
  const isMobile = hasDep('react-native') || hasDep('expo') || hasDep('@react-native-community/cli') || primaryLanguage === 'Dart';
  const isDesktop = hasDep('electron') || hasDep('@tauri-apps/api') || exists(/(^|\/)(src-tauri|tauri\.conf\.json)/);
  const isGame = hasDep('steamworks.js') || hasDep('greenworks') || hasDep('phaser')
    || exists(/\.(godot|uproject)$/) || exists(/(^|\/)(project\.godot|Assets\/.*\.unity)$/);

  let archetype;
  if (isGame) archetype = 'game';
  else if (isDesktop) archetype = 'desktop';
  else if (isMobile) archetype = 'mobile';
  else if (hasNext || (hasVite && hasReact) || (hasReact && hasHtml) || hasWebFw) archetype = 'web-app';
  else if (hasApiFw && !hasUI) archetype = 'api-service';
  else if (hasBin || hasCliDep) archetype = 'cli';
  else if (hasMainExports && !hasAppEntry) archetype = 'library';
  else archetype = 'unknown';

  // ── summary ──
  const parts = [];
  const primaryFw = frameworks[0] || null;
  if (primaryFw) {
    const major = FRAMEWORK_DEP[primaryFw] ? depMajor(deps[FRAMEWORK_DEP[primaryFw]]) : null;
    parts.push(major ? `${primaryFw} ${major}` : primaryFw);
  }
  if (primaryLanguage) parts.push(primaryLanguage);
  if (ui.length) parts.push(ui.join(' + '));
  if (databases.length) parts.push(databases.join(', '));
  parts.push(ARCHETYPE_LABEL[archetype]);
  const summary = parts.join(' · ');

  return {
    languages,
    primaryLanguage,
    runtime,
    packageManager,
    frameworks,
    ui,
    databases,
    buildTools,
    monorepo,
    archetype,
    summary,
  };
}

// ── manifest recognition (for main() — read content only for these) ──
const MANIFEST_BASENAMES = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'components.json', 'setup.py',
]);
const MANIFEST_RE = [
  /(^|\/)next\.config\.[mc]?[jt]s$/, /(^|\/)vite\.config\.[mc]?[jt]s$/,
  /(^|\/)tailwind\.config\.[mc]?[jt]s$/, /(^|\/)svelte\.config\.[mc]?[jt]s$/,
  /(^|\/)astro\.config\.[mc]?[jt]s$/, /(^|\/)tsconfig(\.\w+)?\.json$/,
];
function isManifest(rel) {
  const base = rel.split('/').pop();
  if (MANIFEST_BASENAMES.has(base)) return true;
  return MANIFEST_RE.some((re) => re.test(rel));
}

// ── CLI ──
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage', 'graphify-out', 'vendor']);
function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'stack-profile.json');
  const all = walk(repo);
  const files = [];
  for (const full of all) {
    const rel = path.relative(repo, full);
    let content;
    if (isManifest(rel)) {
      try { if (fs.statSync(full).size < 512 * 1024) content = fs.readFileSync(full, 'utf8'); } catch { /* ignore */ }
    }
    files.push({ rel, content });
  }
  const profile = buildStackProfile(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...profile }, null, 2));
  console.error(`[stack-profile] ${profile.summary} | runtime:${profile.runtime || 'none'} pm:${profile.packageManager || 'none'} → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
