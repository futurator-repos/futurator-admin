import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettierConfig from 'eslint-config-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['node_modules/**', '.next/**', 'out/**', 'coverage/**']),
  // sst-env.d.ts is auto-generated ("Do not edit") and SST emits a blanket
  // `/* eslint-disable */` header. With no lint violations to suppress that
  // directive reports as "unused" — silence the report for this one file so an
  // explicit-file lint (`eslint --max-warnings 0 sst-env.d.ts`) stays clean
  // without ignoring it (an ignored file passed explicitly warns instead).
  {
    files: ['sst-env.d.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  prettierConfig,
]);

export default eslintConfig;
