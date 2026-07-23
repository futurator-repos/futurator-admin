/**
 * Bootstrap Decisions — Config & Decision Inference for Brownfield Projects
 * Story MY-6.3
 *
 * Reads configuration files (package.json, tsconfig.json, Dockerfile, etc.)
 * and infers architectural decisions. Creates decision articles in
 * knowledge/decisions/ with ADR format and INFORMS edges to code articles.
 * Generates knowledge/solutioning/architecture-overview.md.
 *
 * Usage:
 *   node bootstrap-decisions.mjs --dir /home/ubuntu/projects/spyhunter
 *   node bootstrap-decisions.mjs --dir /path --json
 *
 * Exports:
 *   inferDecisions(knowledgeDir, workingDir) — main entry point
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, extname, basename } from 'path';

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
  console.log(`[${ts}] ${prefix[level] || level} [bootstrap-decisions] ${msg}${extra}`);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function toSlug(filePath) {
  return filePath.replace(/\//g, '--').replace(/\\/g, '--');
}

// ── Config File Discovery ──

/**
 * Config files to look for and their purposes.
 */
const CONFIG_FILE_PATTERNS = [
  'package.json',
  'tsconfig.json',
  'tsconfig.*.json',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.env.example',
  '.env.sample',
  'README.md',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'prettier.config.js',
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'vitest.config.js',
  'vitest.config.ts',
  'vitest.config.mjs',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'postcss.config.js',
  'postcss.config.mjs',
  'webpack.config.js',
  'webpack.config.ts',
  '.babelrc',
  'babel.config.js',
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  'Makefile',
  'serverless.yml',
  'serverless.yaml',
  'template.yaml', // SAM
  'cdk.json',
  'prisma/schema.prisma',
  'drizzle.config.ts',
];

/**
 * Discover config files in the project root and common locations.
 */
function discoverConfigFiles(workingDir) {
  const found = {};

  for (const pattern of CONFIG_FILE_PATTERNS) {
    if (pattern.includes('*')) {
      // Glob-like — handle simple cases
      const parts = pattern.split('/');
      const dir = parts.slice(0, -1).join('/');
      const filePattern = parts[parts.length - 1];
      const fullDir = join(workingDir, dir);

      if (existsSync(fullDir)) {
        try {
          const entries = readdirSync(fullDir);
          for (const entry of entries) {
            const ext = filePattern.replace('*', '');
            if (entry.endsWith(ext.replace('*.', '.'))) {
              const fullPath = join(fullDir, entry);
              const relPath = `${dir}/${entry}`;
              try {
                found[relPath] = readFileSync(fullPath, 'utf-8');
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } else {
      const fullPath = join(workingDir, pattern);
      if (existsSync(fullPath)) {
        try {
          found[pattern] = readFileSync(fullPath, 'utf-8');
        } catch { /* skip unreadable */ }
      }
    }
  }

  return found;
}

// ── Package.json Analysis ──

/**
 * Well-known npm packages categorized by decision type.
 */
const PACKAGE_CATEGORIES = {
  framework: {
    'next': { name: 'Next.js', tags: ['nextjs', 'react', 'ssr'] },
    'react': { name: 'React', tags: ['react', 'ui'] },
    'vue': { name: 'Vue.js', tags: ['vue', 'ui'] },
    'nuxt': { name: 'Nuxt', tags: ['nuxt', 'vue', 'ssr'] },
    'svelte': { name: 'Svelte', tags: ['svelte', 'ui'] },
    '@sveltejs/kit': { name: 'SvelteKit', tags: ['sveltekit', 'svelte', 'ssr'] },
    'express': { name: 'Express', tags: ['express', 'api', 'backend'] },
    'fastify': { name: 'Fastify', tags: ['fastify', 'api', 'backend'] },
    'hono': { name: 'Hono', tags: ['hono', 'api', 'backend'] },
    'koa': { name: 'Koa', tags: ['koa', 'api', 'backend'] },
    'nest': { name: 'NestJS', tags: ['nestjs', 'backend'] },
    '@nestjs/core': { name: 'NestJS', tags: ['nestjs', 'backend'] },
    'astro': { name: 'Astro', tags: ['astro', 'static'] },
    'gatsby': { name: 'Gatsby', tags: ['gatsby', 'react', 'static'] },
    'remix': { name: 'Remix', tags: ['remix', 'react', 'ssr'] },
    '@remix-run/react': { name: 'Remix', tags: ['remix', 'react', 'ssr'] },
    'angular': { name: 'Angular', tags: ['angular', 'ui'] },
    '@angular/core': { name: 'Angular', tags: ['angular', 'ui'] },
  },
  database: {
    'prisma': { name: 'Prisma', tags: ['prisma', 'orm', 'database'] },
    '@prisma/client': { name: 'Prisma', tags: ['prisma', 'orm', 'database'] },
    'mongoose': { name: 'Mongoose (MongoDB)', tags: ['mongoose', 'mongodb', 'database'] },
    'mongodb': { name: 'MongoDB', tags: ['mongodb', 'database'] },
    'pg': { name: 'PostgreSQL', tags: ['postgresql', 'database'] },
    'mysql2': { name: 'MySQL', tags: ['mysql', 'database'] },
    'better-sqlite3': { name: 'SQLite', tags: ['sqlite', 'database'] },
    'drizzle-orm': { name: 'Drizzle ORM', tags: ['drizzle', 'orm', 'database'] },
    'typeorm': { name: 'TypeORM', tags: ['typeorm', 'orm', 'database'] },
    'sequelize': { name: 'Sequelize', tags: ['sequelize', 'orm', 'database'] },
    '@aws-sdk/client-dynamodb': { name: 'DynamoDB', tags: ['dynamodb', 'aws', 'database'] },
    '@aws-sdk/lib-dynamodb': { name: 'DynamoDB', tags: ['dynamodb', 'aws', 'database'] },
    'dynamodb-toolbox': { name: 'DynamoDB Toolbox', tags: ['dynamodb', 'aws', 'database'] },
    'redis': { name: 'Redis', tags: ['redis', 'cache', 'database'] },
    'ioredis': { name: 'Redis (ioredis)', tags: ['redis', 'cache', 'database'] },
  },
  auth: {
    'next-auth': { name: 'NextAuth.js', tags: ['nextauth', 'authentication'] },
    '@auth/core': { name: 'Auth.js', tags: ['authjs', 'authentication'] },
    'passport': { name: 'Passport.js', tags: ['passport', 'authentication'] },
    'jsonwebtoken': { name: 'JWT', tags: ['jwt', 'authentication'] },
    'jose': { name: 'JOSE (JWT)', tags: ['jwt', 'jose', 'authentication'] },
    '@aws-sdk/client-cognito-identity-provider': { name: 'AWS Cognito', tags: ['cognito', 'aws', 'authentication'] },
    'firebase-admin': { name: 'Firebase Auth', tags: ['firebase', 'authentication'] },
    'clerk': { name: 'Clerk', tags: ['clerk', 'authentication'] },
    '@clerk/nextjs': { name: 'Clerk', tags: ['clerk', 'authentication'] },
    'supabase': { name: 'Supabase Auth', tags: ['supabase', 'authentication'] },
    '@supabase/supabase-js': { name: 'Supabase', tags: ['supabase', 'authentication'] },
    'bcrypt': { name: 'bcrypt', tags: ['bcrypt', 'password-hashing'] },
    'bcryptjs': { name: 'bcryptjs', tags: ['bcrypt', 'password-hashing'] },
  },
  styling: {
    'tailwindcss': { name: 'Tailwind CSS', tags: ['tailwind', 'css', 'styling'] },
    'styled-components': { name: 'styled-components', tags: ['styled-components', 'css-in-js', 'styling'] },
    '@emotion/react': { name: 'Emotion', tags: ['emotion', 'css-in-js', 'styling'] },
    '@emotion/styled': { name: 'Emotion', tags: ['emotion', 'css-in-js', 'styling'] },
    'sass': { name: 'Sass/SCSS', tags: ['sass', 'scss', 'styling'] },
    '@mantine/core': { name: 'Mantine', tags: ['mantine', 'ui-library', 'styling'] },
    '@chakra-ui/react': { name: 'Chakra UI', tags: ['chakra', 'ui-library', 'styling'] },
    '@mui/material': { name: 'Material UI', tags: ['mui', 'ui-library', 'styling'] },
    'antd': { name: 'Ant Design', tags: ['antd', 'ui-library', 'styling'] },
    'bootstrap': { name: 'Bootstrap', tags: ['bootstrap', 'ui-library', 'styling'] },
    'radix-ui': { name: 'Radix UI', tags: ['radix', 'ui-library', 'styling'] },
    '@radix-ui/react-slot': { name: 'Radix UI', tags: ['radix', 'ui-library', 'styling'] },
    'class-variance-authority': { name: 'CVA', tags: ['cva', 'styling'] },
    'clsx': { name: 'clsx', tags: ['clsx', 'styling'] },
  },
  testing: {
    'jest': { name: 'Jest', tags: ['jest', 'testing'] },
    'vitest': { name: 'Vitest', tags: ['vitest', 'testing'] },
    '@testing-library/react': { name: 'React Testing Library', tags: ['testing-library', 'testing'] },
    '@testing-library/jest-dom': { name: 'jest-dom', tags: ['testing-library', 'testing'] },
    'cypress': { name: 'Cypress', tags: ['cypress', 'e2e', 'testing'] },
    'playwright': { name: 'Playwright', tags: ['playwright', 'e2e', 'testing'] },
    '@playwright/test': { name: 'Playwright', tags: ['playwright', 'e2e', 'testing'] },
    'mocha': { name: 'Mocha', tags: ['mocha', 'testing'] },
    'chai': { name: 'Chai', tags: ['chai', 'testing'] },
    'supertest': { name: 'Supertest', tags: ['supertest', 'api-testing', 'testing'] },
  },
  bundler: {
    'vite': { name: 'Vite', tags: ['vite', 'bundler', 'build'] },
    'webpack': { name: 'Webpack', tags: ['webpack', 'bundler', 'build'] },
    'esbuild': { name: 'esbuild', tags: ['esbuild', 'bundler', 'build'] },
    'rollup': { name: 'Rollup', tags: ['rollup', 'bundler', 'build'] },
    'turbopack': { name: 'Turbopack', tags: ['turbopack', 'bundler', 'build'] },
    'parcel': { name: 'Parcel', tags: ['parcel', 'bundler', 'build'] },
    'tsup': { name: 'tsup', tags: ['tsup', 'bundler', 'build'] },
    'swc': { name: 'SWC', tags: ['swc', 'compiler', 'build'] },
    '@swc/core': { name: 'SWC', tags: ['swc', 'compiler', 'build'] },
  },
  stateManagement: {
    'zustand': { name: 'Zustand', tags: ['zustand', 'state-management'] },
    'redux': { name: 'Redux', tags: ['redux', 'state-management'] },
    '@reduxjs/toolkit': { name: 'Redux Toolkit', tags: ['redux', 'state-management'] },
    'recoil': { name: 'Recoil', tags: ['recoil', 'state-management'] },
    'jotai': { name: 'Jotai', tags: ['jotai', 'state-management'] },
    'mobx': { name: 'MobX', tags: ['mobx', 'state-management'] },
    '@tanstack/react-query': { name: 'TanStack Query', tags: ['react-query', 'data-fetching'] },
    'swr': { name: 'SWR', tags: ['swr', 'data-fetching'] },
  },
  deployment: {
    '@aws-cdk/core': { name: 'AWS CDK', tags: ['aws-cdk', 'iac', 'deployment'] },
    'aws-cdk-lib': { name: 'AWS CDK', tags: ['aws-cdk', 'iac', 'deployment'] },
    'serverless': { name: 'Serverless Framework', tags: ['serverless', 'deployment'] },
    '@pulumi/pulumi': { name: 'Pulumi', tags: ['pulumi', 'iac', 'deployment'] },
    'vercel': { name: 'Vercel', tags: ['vercel', 'deployment'] },
  },
};

/**
 * Analyze package.json to extract dependency categorizations.
 */
function analyzePackageJson(content) {
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    log('warn', 'Could not parse package.json');
    return { detected: [], scripts: {} };
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const detected = [];

  for (const [category, packages] of Object.entries(PACKAGE_CATEGORIES)) {
    for (const [pkgName, info] of Object.entries(packages)) {
      if (allDeps[pkgName]) {
        detected.push({
          category,
          package: pkgName,
          version: allDeps[pkgName],
          name: info.name,
          tags: info.tags,
          isDev: !!pkg.devDependencies?.[pkgName],
        });
      }
    }
  }

  return {
    detected,
    scripts: pkg.scripts || {},
    name: pkg.name,
    version: pkg.version,
    allDeps,
  };
}

// ── Decision Inference ──

/**
 * Infer decisions from detected packages and config files.
 * Groups by category and selects the primary choice per category.
 */
function inferDecisionsFromAnalysis(pkgAnalysis, configFiles, workingDir) {
  const decisions = [];

  // Group detected packages by category
  const byCategory = {};
  for (const det of pkgAnalysis.detected) {
    if (!byCategory[det.category]) byCategory[det.category] = [];
    byCategory[det.category].push(det);
  }

  // -- Framework decision --
  if (byCategory.framework) {
    const frameworks = byCategory.framework;
    // Prioritize: meta-framework > UI framework > server framework
    const primary = frameworks[0]; // Already ordered by specificity in detection
    const evidence = frameworks.map(f =>
      `- \`package.json\`: \`"${f.package}": "${f.version}"\` in ${f.isDev ? 'devDependencies' : 'dependencies'}`
    );

    // Check for specific config files
    if (configFiles['next.config.js'] || configFiles['next.config.mjs'] || configFiles['next.config.ts']) {
      evidence.push('- `next.config.*`: Next.js configuration file present');
    }
    if (configFiles['vite.config.js'] || configFiles['vite.config.ts'] || configFiles['vite.config.mjs']) {
      evidence.push('- `vite.config.*`: Vite configuration file present');
    }

    decisions.push({
      category: 'framework',
      choice: primary.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      title: `Framework - ${primary.name}`,
      context: `Project uses ${primary.name} as the primary application framework.${
        frameworks.length > 1 ? ` Also detected: ${frameworks.slice(1).map(f => f.name).join(', ')}.` : ''
      }`,
      chosenOption: `${primary.name} ${primary.version}`,
      evidence,
      tags: [...new Set(frameworks.flatMap(f => f.tags))],
      maturity: evidence.length >= 3 ? 0.5 : 0.4,
    });
  }

  // -- Database decision --
  if (byCategory.database) {
    const dbs = byCategory.database;
    // Deduplicate by name
    const seen = new Set();
    const uniqueDbs = dbs.filter(d => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });

    for (const db of uniqueDbs) {
      const relatedPkgs = dbs.filter(d => d.name === db.name);
      const evidence = relatedPkgs.map(d =>
        `- \`package.json\`: \`"${d.package}": "${d.version}"\``
      );

      // Check for Prisma schema
      if (db.name.includes('Prisma') && configFiles['prisma/schema.prisma']) {
        evidence.push('- `prisma/schema.prisma`: Prisma schema file present');
      }
      // Check docker-compose for DB services
      const compose = configFiles['docker-compose.yml'] || configFiles['docker-compose.yaml'];
      if (compose && (compose.includes('postgres') || compose.includes('mysql') || compose.includes('mongo') || compose.includes('redis'))) {
        evidence.push('- `docker-compose.yml`: Database service defined');
      }

      decisions.push({
        category: 'database',
        choice: db.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        title: `Database - ${db.name}`,
        context: `Project uses ${db.name} for data persistence.`,
        chosenOption: `${db.name} (detected from package.json)`,
        evidence,
        tags: [...new Set(relatedPkgs.flatMap(d => d.tags))],
        maturity: evidence.length >= 2 ? 0.5 : 0.3,
      });
    }
  }

  // -- Auth decision --
  if (byCategory.auth) {
    const auths = byCategory.auth;
    const seen = new Set();
    const uniqueAuths = auths.filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });

    for (const auth of uniqueAuths) {
      const relatedPkgs = auths.filter(a => a.name === auth.name);
      const evidence = relatedPkgs.map(a =>
        `- \`package.json\`: \`"${a.package}": "${a.version}"\``
      );

      // Check .env.example for auth-related vars
      const envExample = configFiles['.env.example'] || configFiles['.env.sample'] || '';
      if (envExample) {
        const authVars = envExample.split('\n')
          .filter(l => /auth|jwt|token|secret|cognito|clerk|supabase/i.test(l))
          .slice(0, 3);
        if (authVars.length > 0) {
          evidence.push(`- \`.env.example\`: Auth-related vars: ${authVars.map(v => v.split('=')[0].trim()).join(', ')}`);
        }
      }

      decisions.push({
        category: 'auth',
        choice: auth.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        title: `Authentication - ${auth.name}`,
        context: `Project uses ${auth.name} for authentication.`,
        chosenOption: `${auth.name} (detected from package.json)`,
        evidence,
        tags: [...new Set(relatedPkgs.flatMap(a => a.tags))],
        maturity: evidence.length >= 2 ? 0.4 : 0.3,
      });
    }
  }

  // -- Styling decision --
  if (byCategory.styling) {
    const styles = byCategory.styling;
    const seen = new Set();
    const uniqueStyles = styles.filter(s => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });

    // Pick primary styling approach
    const primary = uniqueStyles[0];
    const evidence = styles.map(s =>
      `- \`package.json\`: \`"${s.package}": "${s.version}"\``
    );

    if (configFiles['tailwind.config.js'] || configFiles['tailwind.config.ts'] || configFiles['tailwind.config.mjs']) {
      evidence.push('- `tailwind.config.*`: Tailwind configuration present');
    }
    if (configFiles['postcss.config.js'] || configFiles['postcss.config.mjs']) {
      evidence.push('- `postcss.config.*`: PostCSS configuration present');
    }

    decisions.push({
      category: 'styling',
      choice: primary.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      title: `Styling - ${primary.name}`,
      context: `Project uses ${primary.name} for styling.${
        uniqueStyles.length > 1 ? ` Also uses: ${uniqueStyles.slice(1).map(s => s.name).join(', ')}.` : ''
      }`,
      chosenOption: `${primary.name} (detected from package.json)`,
      evidence,
      tags: [...new Set(styles.flatMap(s => s.tags))],
      maturity: evidence.length >= 3 ? 0.5 : 0.4,
    });
  }

  // -- Testing decision --
  if (byCategory.testing) {
    const tests = byCategory.testing;
    const seen = new Set();
    const uniqueTests = tests.filter(t => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });

    const primary = uniqueTests[0];
    const evidence = tests.map(t =>
      `- \`package.json\`: \`"${t.package}": "${t.version}"\` in ${t.isDev ? 'devDependencies' : 'dependencies'}`
    );

    // Check for test config files
    for (const configName of ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs']) {
      if (configFiles[configName]) {
        evidence.push(`- \`${configName}\`: Test framework configuration present`);
      }
    }

    // Check package.json scripts for test commands
    if (pkgAnalysis.scripts.test) {
      evidence.push(`- \`package.json scripts.test\`: \`${pkgAnalysis.scripts.test}\``);
    }

    decisions.push({
      category: 'testing',
      choice: primary.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      title: `Testing - ${primary.name}`,
      context: `Project uses ${primary.name} as the primary testing framework.${
        uniqueTests.length > 1 ? ` Also uses: ${uniqueTests.slice(1).map(t => t.name).join(', ')}.` : ''
      }`,
      chosenOption: `${primary.name} (detected from package.json)`,
      evidence,
      tags: [...new Set(tests.flatMap(t => t.tags))],
      maturity: evidence.length >= 3 ? 0.5 : 0.4,
    });
  }

  // -- Bundler decision --
  if (byCategory.bundler) {
    const bundlers = byCategory.bundler;
    const primary = bundlers[0];
    const evidence = bundlers.map(b =>
      `- \`package.json\`: \`"${b.package}": "${b.version}"\``
    );

    for (const configName of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'webpack.config.js', 'webpack.config.ts']) {
      if (configFiles[configName]) {
        evidence.push(`- \`${configName}\`: Bundler configuration present`);
      }
    }

    decisions.push({
      category: 'bundler',
      choice: primary.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      title: `Build Tool - ${primary.name}`,
      context: `Project uses ${primary.name} as the build tool/bundler.`,
      chosenOption: `${primary.name} (detected from package.json)`,
      evidence,
      tags: [...new Set(bundlers.flatMap(b => b.tags))],
      maturity: evidence.length >= 2 ? 0.5 : 0.4,
    });
  }

  // -- State Management decision --
  if (byCategory.stateManagement) {
    const states = byCategory.stateManagement;
    const primary = states[0];
    const evidence = states.map(s =>
      `- \`package.json\`: \`"${s.package}": "${s.version}"\``
    );

    decisions.push({
      category: 'state-management',
      choice: primary.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      title: `State Management - ${primary.name}`,
      context: `Project uses ${primary.name} for state management.`,
      chosenOption: `${primary.name} (detected from package.json)`,
      evidence,
      tags: [...new Set(states.flatMap(s => s.tags))],
      maturity: 0.4,
    });
  }

  // -- Deployment decision (from Dockerfile, CI, etc.) --
  const deployEvidence = [];
  let deployChoice = null;

  if (configFiles['Dockerfile']) {
    deployEvidence.push('- `Dockerfile`: Container deployment configured');
    deployChoice = 'docker';
  }
  if (configFiles['docker-compose.yml'] || configFiles['docker-compose.yaml']) {
    deployEvidence.push('- `docker-compose.yml`: Multi-service orchestration defined');
    if (!deployChoice) deployChoice = 'docker-compose';
  }
  if (byCategory.deployment) {
    for (const d of byCategory.deployment) {
      deployEvidence.push(`- \`package.json\`: \`"${d.package}": "${d.version}"\``);
      deployChoice = deployChoice || d.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
  }
  // Check for CI/CD configs
  for (const [name, content] of Object.entries(configFiles)) {
    if (name.includes('.github/workflows/')) {
      deployEvidence.push(`- \`${name}\`: GitHub Actions workflow`);
      if (!deployChoice) deployChoice = 'github-actions';
    }
  }
  if (configFiles['serverless.yml'] || configFiles['serverless.yaml']) {
    deployEvidence.push('- `serverless.yml`: Serverless Framework configuration');
    deployChoice = deployChoice || 'serverless';
  }

  if (deployEvidence.length > 0) {
    decisions.push({
      category: 'deployment',
      choice: deployChoice || 'custom',
      title: `Deployment - ${deployChoice || 'Custom'}`,
      context: `Project deployment strategy inferred from configuration files.`,
      chosenOption: `${deployChoice || 'Custom deployment'} (detected from config files)`,
      evidence: deployEvidence,
      tags: ['deployment', 'infrastructure', deployChoice].filter(Boolean),
      maturity: deployEvidence.length >= 2 ? 0.4 : 0.3,
    });
  }

  // -- TypeScript configuration decision --
  if (configFiles['tsconfig.json']) {
    try {
      let raw = configFiles['tsconfig.json'];
      raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(raw);
      const compilerOpts = tsconfig.compilerOptions || {};
      const evidence = [`- \`tsconfig.json\`: TypeScript configuration present`];

      if (compilerOpts.strict !== undefined) {
        evidence.push(`- Strict mode: ${compilerOpts.strict ? 'enabled' : 'disabled'}`);
      }
      if (compilerOpts.target) {
        evidence.push(`- Compilation target: ${compilerOpts.target}`);
      }
      if (compilerOpts.module) {
        evidence.push(`- Module system: ${compilerOpts.module}`);
      }
      if (compilerOpts.paths) {
        evidence.push(`- Path aliases configured: ${Object.keys(compilerOpts.paths).join(', ')}`);
      }

      decisions.push({
        category: 'language',
        choice: 'typescript',
        title: 'Language - TypeScript',
        context: `Project uses TypeScript with ${compilerOpts.strict ? 'strict' : 'non-strict'} mode.`,
        chosenOption: `TypeScript (target: ${compilerOpts.target || 'default'}, module: ${compilerOpts.module || 'default'})`,
        evidence,
        tags: ['typescript', 'language', 'type-safety'],
        maturity: 0.5,
      });
    } catch { /* skip invalid tsconfig */ }
  }

  return decisions;
}

// ── Article Generation ──

/**
 * Find code articles that are informed by a decision.
 * Returns article slugs that match tags or import related packages.
 */
function findInformedArticles(decision, knowledgeDir) {
  const codeDir = join(knowledgeDir, 'code');
  if (!existsSync(codeDir)) return [];

  const informed = [];
  const files = readdirSync(codeDir).filter(f => f.endsWith('.md'));

  // Sample up to 10 relevant articles
  let count = 0;
  for (const file of files) {
    if (count >= 10) break;

    try {
      const content = readFileSync(join(codeDir, file), 'utf-8');

      // Check if article content references the decision's packages/tech
      const isRelevant = decision.tags.some(tag => {
        const tagLower = tag.toLowerCase();
        return content.toLowerCase().includes(tagLower);
      });

      if (isRelevant) {
        const slug = file.replace(/\.md$/, '');
        informed.push(`code/${slug}`);
        count++;
      }
    } catch { /* skip unreadable */ }
  }

  return informed;
}

/**
 * Generate a decision article markdown string.
 */
function generateDecisionArticle(decision, informedArticles) {
  const dateStr = today();
  const tagsStr = `[${decision.tags.join(', ')}]`;

  const informsSection = informedArticles.length > 0
    ? informedArticles.map(a => `- [[${a}]]`).join('\n')
    : '_No code articles directly linked yet._';

  return `---
title: ${decision.title}
type: decision
phase: solutioning
status: active
maturity: ${decision.maturity}
created: ${dateStr}
updated: ${dateStr}
createdByEpic: bootstrap
createdByStory: bootstrap-decisions
tags: ${tagsStr}
---

## Context

${decision.context}

## Chosen Option

${decision.chosenOption}

## Evidence

${decision.evidence.join('\n')}

## Alternatives Considered

_Not documented - inferred from existing codebase. Review and refine manually._

## Informs

${informsSection}
`;
}

/**
 * Generate the architecture overview article.
 */
function generateArchitectureOverview(decisions, knowledgeDir, projectId) {
  const dateStr = today();

  let techStack = '| Category | Choice | Maturity |\n|----------|--------|----------|\n';
  const decisionLinks = [];

  for (const d of decisions) {
    const articleName = `${d.category}-${d.choice}`;
    techStack += `| ${d.category} | ${d.title} | ${d.maturity} |\n`;
    decisionLinks.push(`- [[decisions/${articleName}]] - ${d.title}`);
  }

  return `---
title: Architecture Overview - ${projectId}
type: architecture
phase: solutioning
status: active
maturity: 0.4
created: ${dateStr}
updated: ${dateStr}
createdByEpic: bootstrap
createdByStory: bootstrap-decisions
tags: [architecture, overview, tech-stack]
---

## Purpose

Synthesized architecture overview of the ${projectId} project, generated by
analyzing configuration files and package manifests. This document captures
the technology choices inferred from the existing codebase.

**Note:** This overview was reverse-engineered by the brownfield bootstrap pipeline.
Maturity scores are between 0.3-0.5 indicating these decisions should be reviewed
and refined by the development team.

## Tech Stack

${techStack}

## Decision Articles

${decisionLinks.join('\n')}

## Project Structure

_Inferred from source file analysis. Review and enhance with architectural
diagrams and component interaction descriptions._

## Signals

- ${decisions.length} architectural decisions inferred from config files
- Maturity range: ${Math.min(...decisions.map(d => d.maturity))}-${Math.max(...decisions.map(d => d.maturity))}

## Missing Signals

- Detailed rationale for technology choices not documented
- Deployment architecture diagram not generated
- Service interaction patterns not analyzed
- Performance requirements not captured
`;
}

// ── Pipeline Event Emission ──

function emitEvent(event) {
  log('info', `Pipeline event: ${event.type}`, event);
}

// ── Main Decision Inference ──

/**
 * Main decision inference function.
 *
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {string} workingDir - Path to project root
 * @param {object} opts - Options
 * @returns {object} Inference results
 */
export async function inferDecisions(knowledgeDir, workingDir, opts = {}) {
  const startTime = Date.now();

  log('info', 'Starting decision inference', { knowledgeDir, workingDir });

  // Step 1: Discover config files
  const configFiles = discoverConfigFiles(workingDir);
  const configNames = Object.keys(configFiles);
  log('info', `Discovered ${configNames.length} config file(s)`, { files: configNames });

  emitEvent({
    type: 'progress',
    stage: 'decisions',
    message: `Found ${configNames.length} config files`,
  });

  // Step 2: Analyze package.json
  let pkgAnalysis = { detected: [], scripts: {} };
  if (configFiles['package.json']) {
    pkgAnalysis = analyzePackageJson(configFiles['package.json']);
    log('info', `Detected ${pkgAnalysis.detected.length} known package(s) in package.json`);
  }

  // Step 3: Infer decisions
  const decisions = inferDecisionsFromAnalysis(pkgAnalysis, configFiles, workingDir);
  log('info', `Inferred ${decisions.length} architectural decision(s)`);

  // Step 4: Generate decision articles
  const projectId = opts.projectId || basename(workingDir);
  const decisionArticles = [];

  for (const decision of decisions) {
    const articleName = `${decision.category}-${decision.choice}`;
    const articlePath = join(knowledgeDir, 'decisions', `${articleName}.md`);

    // Find code articles that this decision informs
    const informedArticles = findInformedArticles(decision, knowledgeDir);

    // Generate article
    const article = generateDecisionArticle(decision, informedArticles);
    writeFileSync(articlePath, article, 'utf-8');

    decisionArticles.push({
      name: articleName,
      path: `knowledge/decisions/${articleName}.md`,
      category: decision.category,
      choice: decision.choice,
      title: decision.title,
      maturity: decision.maturity,
      informsCount: informedArticles.length,
    });

    log('info', `Created decision article: ${articleName}`, {
      maturity: decision.maturity,
      evidence: decision.evidence.length,
      informs: informedArticles.length,
    });
  }

  emitEvent({
    type: 'progress',
    stage: 'decisions',
    message: `Generated ${decisionArticles.length} decision articles`,
    decisionsInferred: decisionArticles.length,
  });

  // Step 5: Generate architecture overview
  const overviewContent = generateArchitectureOverview(decisions, knowledgeDir, projectId);
  const overviewPath = join(knowledgeDir, 'solutioning', 'architecture-overview.md');
  writeFileSync(overviewPath, overviewContent, 'utf-8');
  log('info', 'Generated architecture-overview.md');

  // Step 6: Update index.md
  updateIndexForDecisions(knowledgeDir, decisionArticles);

  // Step 7: Append to log.md
  const durationMs = Date.now() - startTime;
  appendDecisionsLog(knowledgeDir, {
    decisionsInferred: decisions.length,
    configFilesAnalyzed: configNames.length,
    maturityDistribution: decisions.reduce((acc, d) => {
      const key = `${d.maturity}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    durationMs,
  });

  // Emit completion event
  emitEvent({
    type: 'complete',
    stage: 'decisions',
    decisionsInferred: decisions.length,
    configFilesAnalyzed: configNames.length,
    durationMs,
  });

  return {
    decisionsInferred: decisions.length,
    decisionArticles,
    configFilesAnalyzed: configNames.length,
    configFiles: configNames,
    durationMs,
  };
}

/**
 * Update knowledge/index.md with decision and solutioning articles.
 */
function updateIndexForDecisions(knowledgeDir, decisionArticles) {
  const indexPath = join(knowledgeDir, 'index.md');
  if (!existsSync(indexPath)) return;

  let content = readFileSync(indexPath, 'utf-8');

  // Add decision articles
  const newRows = [];
  for (const article of decisionArticles) {
    if (!content.includes(article.name)) {
      newRows.push(`| ${article.title} | decision | solutioning | active | \`${article.path}\` |`);
    }
  }

  // Add architecture overview
  if (!content.includes('architecture-overview')) {
    newRows.push(`| Architecture Overview | architecture | solutioning | active | \`knowledge/solutioning/architecture-overview.md\` |`);
  }

  if (newRows.length > 0) {
    const lines = content.split('\n');
    const tableHeaderIdx = lines.findIndex(l => l.includes('|-------|'));
    if (tableHeaderIdx >= 0) {
      let insertIdx = tableHeaderIdx + 1;
      while (insertIdx < lines.length && lines[insertIdx].startsWith('|')) {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, ...newRows);
      content = lines.join('\n');
    } else {
      content += '\n' + newRows.join('\n') + '\n';
    }

    writeFileSync(indexPath, content, 'utf-8');
  }
}

/**
 * Append decision inference record to knowledge/log.md.
 */
function appendDecisionsLog(knowledgeDir, stats) {
  const logPath = join(knowledgeDir, 'log.md');
  if (!existsSync(logPath)) return;

  const existing = readFileSync(logPath, 'utf-8');
  const entry = `
### bootstrap-decisions - ${new Date().toISOString()}

- **Decisions Inferred:** ${stats.decisionsInferred}
- **Config Files Analyzed:** ${stats.configFilesAnalyzed}
- **Maturity Distribution:** ${JSON.stringify(stats.maturityDistribution)}
- **Duration:** ${(stats.durationMs / 1000).toFixed(1)}s
`;

  writeFileSync(logPath, existing + entry, 'utf-8');
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);

  let workingDir = null;
  let projectId = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
      case '--working-dir':
        workingDir = args[++i];
        break;
      case '--project':
        projectId = args[++i];
        break;
      case '--json':
        jsonOutput = true;
        break;
      case '--help':
        console.log(`
Usage: node bootstrap-decisions.mjs --dir <path> [options]

Options:
  --dir <path>       Path to project root directory
  --project <id>     Project identifier (default: directory name)
  --json             Output results as JSON
  --help             Show this help message
`);
        process.exit(0);
    }
  }

  if (!workingDir) {
    console.error('Error: --dir is required');
    console.error('Usage: node bootstrap-decisions.mjs --dir /path/to/project');
    process.exit(1);
  }

  const knowledgeDir = join(workingDir, 'knowledge');
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: knowledge/ directory not found at ${knowledgeDir}`);
    console.error('Run bootstrap-scan.mjs first to generate wiki structure.');
    process.exit(1);
  }

  try {
    const result = await inferDecisions(knowledgeDir, workingDir, { projectId });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n=== Decision Inference Complete ===');
      console.log(`  Decisions inferred:  ${result.decisionsInferred}`);
      console.log(`  Config files read:   ${result.configFilesAnalyzed}`);
      console.log(`  Decision articles:`);
      for (const a of result.decisionArticles) {
        console.log(`    - ${a.title} (maturity: ${a.maturity}, informs: ${a.informsCount} articles)`);
      }
      console.log(`  Duration:            ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');
    }
  } catch (err) {
    console.error('Decision inference failed:', err.message);
    if (!jsonOutput) console.error(err.stack);
    process.exit(1);
  }
}

// Run if executed directly
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('bootstrap-decisions.mjs') ||
  process.argv[1].endsWith('bootstrap-decisions')
);

if (isDirectExecution) {
  main();
}
