import type { BoilerplateMetadata } from './types';

/** All supported app boilerplate types. */
export type BoilerplateType = 'nextjs' | 'sst' | 'vite' | 'mobile';

/**
 * Single source of truth for every boilerplate type.
 *
 * The `Record<BoilerplateType, …>` type enforces at compile time that every
 * member of the union has an entry — adding a new type without a registry
 * entry is a type error.
 */
export const BOILERPLATE_REGISTRY: Record<BoilerplateType, BoilerplateMetadata> = {
  nextjs: {
    type: 'nextjs',
    displayName: 'Next.js + BMAD',
    icon: '⚛️',
    templateRepo: 'futurator-repos/template-nextjs',
    status: 'wired',
    defaultStack: {
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['package.json', 'README.md', 'CLAUDE.md'],
      },
      { id: 'npm-install' },
      { id: 'bmad-bootstrap' },
      { id: 'commit-and-push' },
    ],
    bmadSupported: true,
    defaultDeployFlavor: 'static-site',
    pmContext: {
      framework: 'Next.js 16 with App Router (TypeScript, strict mode)',
      scaffoldedAlready: [
        'package.json with Next.js 16, React 19, TypeScript deps installed',
        'tsconfig.json (strict mode, paths alias `@/*` → `./src/*`)',
        'next.config.ts with output: "export" for static-site deploy',
        'src/app/layout.tsx + src/app/page.tsx (App Router root)',
        'src/app/globals.css (Tailwind v4 wired)',
        'src/components/ui/ (shadcn primitives)',
        '_bmad/ (BMAD agents installed)',
      ],
      conventions: {
        typesPath: 'src/types/',
        sourceRoot: 'src/',
        pagesOrAppPath: 'src/app/',
        componentsPath: 'src/components/',
        stylesPath: 'src/app/globals.css',
        testsPath: 'src/**/__tests__/',
        configFiles: ['package.json', 'tsconfig.json', 'next.config.ts', 'tailwind.config.ts'],
      },
      exampleAcceptanceCriteria: [
        'npm run build exits with code 0',
        'tsc --noEmit reports zero errors',
        'src/app/page.tsx renders without hydration warnings in dev mode',
        'All exports from src/types/index.ts are importable via `@/types`',
      ],
    },
  },

  sst: {
    type: 'sst',
    displayName: 'SST (Phase 2)',
    icon: '☁️',
    templateRepo: 'futurator-repos/template-sst',
    status: 'stub',
    defaultStack: {
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'sst-app',
    pmContext: {
      framework: 'SST v4 (TypeScript) — Lambda + DynamoDB serverless app',
      scaffoldedAlready: [
        'package.json with SST v4 deps',
        'sst.config.ts (Pulumi-based)',
        'tsconfig.json (strict mode)',
        'functions/ root directory (Lambda handlers)',
      ],
      conventions: {
        typesPath: 'functions/shared/types/',
        sourceRoot: 'functions/',
        pagesOrAppPath: 'functions/api/',
        componentsPath: 'functions/api/handlers/',
        stylesPath: '',
        testsPath: 'functions/**/__tests__/',
        configFiles: ['package.json', 'tsconfig.json', 'sst.config.ts'],
      },
      exampleAcceptanceCriteria: [
        'sst dev exits cleanly when started',
        'tsc --noEmit reports zero errors',
        'New Lambda handler at functions/api/<route>.ts responds to a synthetic event',
      ],
    },
  },

  vite: {
    type: 'vite',
    displayName: 'Vite + React (Phase 2)',
    icon: '⚡',
    templateRepo: 'futurator-repos/template-vite',
    status: 'stub',
    defaultStack: {
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'spa-on-cloudfront',
    pmContext: {
      framework: 'Vite + React + TypeScript (strict mode)',
      scaffoldedAlready: [
        'package.json with Vite, React 19, TypeScript deps',
        'tsconfig.json (strict mode)',
        'vite.config.ts',
        'index.html (Vite entry)',
        'src/main.tsx (React root)',
        'src/App.tsx',
      ],
      conventions: {
        typesPath: 'src/types/',
        sourceRoot: 'src/',
        pagesOrAppPath: 'src/pages/',
        componentsPath: 'src/components/',
        stylesPath: 'src/index.css',
        testsPath: 'src/**/*.test.{ts,tsx}',
        configFiles: ['package.json', 'tsconfig.json', 'vite.config.ts'],
      },
      exampleAcceptanceCriteria: [
        'vite build exits with code 0',
        'tsc --noEmit reports zero errors',
        'src/App.tsx renders without console errors at localhost:5173',
        'All exports from src/types/index.ts are importable',
      ],
    },
  },

  mobile: {
    type: 'mobile',
    displayName: 'Expo Mobile (Phase 3)',
    icon: '📱',
    templateRepo: 'futurator-repos/template-mobile',
    status: 'stub',
    defaultStack: {
      runtime: 'react-native',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npx expo start',
      buildCommand: 'npx expo build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'mobile-store',
    pmContext: {
      framework: 'Expo (React Native + TypeScript)',
      scaffoldedAlready: [
        'package.json with Expo SDK + React Native deps',
        'tsconfig.json',
        'app.json (Expo config)',
        'App.tsx',
      ],
      conventions: {
        typesPath: 'src/types/',
        sourceRoot: 'src/',
        pagesOrAppPath: 'src/screens/',
        componentsPath: 'src/components/',
        stylesPath: '',
        testsPath: 'src/**/__tests__/',
        configFiles: ['package.json', 'tsconfig.json', 'app.json'],
      },
      exampleAcceptanceCriteria: [
        'npx expo start launches without errors',
        'tsc --noEmit reports zero errors',
        'App renders on iOS simulator without runtime errors',
      ],
    },
  },
};

/**
 * Returns the metadata for the given boilerplate type.
 *
 * Throws `Error('unknown boilerplate type: <x>')` for any value not in the
 * registry. Use this at runtime when the type comes from an untrusted source
 * (e.g. an API request body that has been Zod-coerced but not yet validated
 * against the registry).
 */
export function getBoilerplateMetadata(type: BoilerplateType): BoilerplateMetadata {
  const metadata = BOILERPLATE_REGISTRY[type];
  if (!metadata) {
    throw new Error(`unknown boilerplate type: ${type}`);
  }
  return metadata;
}

/**
 * Returns the subset of boilerplate types whose `status === 'wired'`.
 * Phase 1: only `['nextjs']`.
 */
export function getWiredBoilerplateTypes(): BoilerplateType[] {
  return (Object.keys(BOILERPLATE_REGISTRY) as BoilerplateType[]).filter(
    (type) => BOILERPLATE_REGISTRY[type].status === 'wired',
  );
}
