/**
 * stack-profile.test.mjs — deterministic, manifest+extension-driven stack detection.
 * Covers Node/Next, Python, archetype (web vs api vs library), and UI (Tailwind + shadcn).
 */

import { describe, it, expect } from 'vitest';
import { buildStackProfile } from '../stack-profile.mjs';

const pkg = (obj) => ({ rel: 'package.json', content: JSON.stringify(obj) });

describe('buildStackProfile — Node / Next.js', () => {
  it('detects Next.js + React + TypeScript + npm + web-app', () => {
    const profile = buildStackProfile([
      pkg({ dependencies: { next: '^16.0.0', react: '^19.0.0' } }),
      { rel: 'package-lock.json' },
      { rel: 'src/app/page.tsx' },
      { rel: 'src/components/nav.tsx' },
      { rel: 'src/lib/util.ts' },
    ]);
    expect(profile.runtime).toBe('node');
    expect(profile.packageManager).toBe('npm');
    expect(profile.frameworks).toContain('Next.js');
    expect(profile.frameworks).toContain('React');
    expect(profile.primaryLanguage).toBe('TypeScript');
    expect(profile.archetype).toBe('web-app');
    expect(profile.summary).toContain('Next.js 16');
    expect(profile.summary).toContain('web app');
  });

  it('picks pnpm from lockfile and detects turbo monorepo', () => {
    const profile = buildStackProfile([
      pkg({ dependencies: { next: '15.0.0' }, devDependencies: { turbo: '^2.0.0' } }),
      { rel: 'pnpm-lock.yaml' },
      { rel: 'turbo.json' },
      { rel: 'apps/web/page.tsx' },
    ]);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.monorepo).toBe('turbo');
  });
});

describe('buildStackProfile — Python', () => {
  it('detects Python runtime, FastAPI, poetry, api-service', () => {
    const profile = buildStackProfile([
      { rel: 'pyproject.toml', content: '[tool.poetry]\nname = "svc"\n[tool.poetry.dependencies]\nfastapi = "^0.110"\nsqlalchemy = "^2.0"' },
      { rel: 'app/main.py' },
      { rel: 'app/models.py' },
      { rel: 'app/routes.py' },
    ]);
    expect(profile.runtime).toBe('python');
    expect(profile.primaryLanguage).toBe('Python');
    expect(profile.packageManager).toBe('poetry');
    expect(profile.frameworks).toContain('FastAPI');
    expect(profile.databases).toContain('SQLAlchemy');
    expect(profile.archetype).toBe('api-service');
  });

  it('uses pip when no poetry table and requirements.txt present', () => {
    const profile = buildStackProfile([
      { rel: 'requirements.txt', content: 'flask==3.0\ndjango==5.0' },
      { rel: 'wsgi.py' },
    ]);
    expect(profile.runtime).toBe('python');
    expect(profile.packageManager).toBe('pip');
    expect(profile.frameworks).toContain('Flask');
    expect(profile.frameworks).toContain('Django');
  });
});

describe('buildStackProfile — archetype', () => {
  it('api-service: Hono backend with no UI', () => {
    const profile = buildStackProfile([
      pkg({ dependencies: { hono: '^4.0.0' } }),
      { rel: 'src/index.ts' },
      { rel: 'src/routes.ts' },
    ]);
    expect(profile.frameworks).toContain('Hono');
    expect(profile.ui).toHaveLength(0);
    expect(profile.archetype).toBe('api-service');
  });

  it('library: main/exports and no app entry', () => {
    const profile = buildStackProfile([
      pkg({ name: 'my-lib', main: 'dist/index.js', exports: './dist/index.js', dependencies: {} }),
      { rel: 'src/index.ts' },
      { rel: 'src/helpers.ts' },
    ]);
    expect(profile.archetype).toBe('library');
  });

  it('cli: bin field', () => {
    const profile = buildStackProfile([
      pkg({ name: 'tool', bin: { tool: 'bin/cli.js' }, dependencies: { commander: '^12.0.0' } }),
      { rel: 'bin/cli.js' },
    ]);
    expect(profile.archetype).toBe('cli');
  });
});

describe('buildStackProfile — UI', () => {
  it('detects Tailwind + shadcn/ui', () => {
    const profile = buildStackProfile([
      pkg({ dependencies: { next: '^16.0.0', react: '^19.0.0' }, devDependencies: { tailwindcss: '^4.0.0' } }),
      { rel: 'components.json', content: '{"style":"new-york"}' },
      { rel: 'tailwind.config.ts', content: 'export default {}' },
      { rel: 'src/app/page.tsx' },
    ]);
    expect(profile.ui).toContain('Tailwind');
    expect(profile.ui).toContain('shadcn/ui');
    expect(profile.summary).toContain('Tailwind + shadcn/ui');
  });

  it('detects CSS Modules from file extension', () => {
    const profile = buildStackProfile([
      pkg({ dependencies: { react: '^19.0.0', vite: '^5.0.0' } }),
      { rel: 'src/App.tsx' },
      { rel: 'src/App.module.css' },
      { rel: 'index.html' },
    ]);
    expect(profile.ui).toContain('CSS Modules');
    expect(profile.archetype).toBe('web-app');
  });
});
