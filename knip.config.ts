import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/app/**/page.tsx',
    'src/app/**/layout.tsx',
    'functions/**/index.ts',
    'functions/**/callback.ts',
    'functions/cron/*.ts',
    'scripts/*.ts',
  ],
  project: ['src/**/*.{ts,tsx}', 'functions/**/*.ts', 'scripts/**/*.ts'],
  ignore: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
  ignoreDependencies: ['@tailwindcss/postcss', '@vitejs/plugin-react'],
  next: {
    entry: ['src/app/**/page.tsx', 'src/app/**/layout.tsx', 'next.config.ts'],
  },
};

export default config;
