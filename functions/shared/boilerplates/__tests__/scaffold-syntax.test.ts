// @vitest-environment node
import nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { BOILERPLATE_REGISTRY } from '../registry';

/**
 * Scaffold files ship as template-string contents inside registry.ts, so `tsc`
 * never parses them — a brace/paren slip in a scaffold is invisible until a
 * generated app fails to build (breaking EVERY new app of that boilerplate).
 *
 * This guard esbuild-transforms every shipped .ts/.tsx scaffold to catch SYNTAX
 * errors (not type errors) at unit-test time. Added with the VQA v3 Phase 2b
 * seam edits (forceStatus/dispatch/__force/events) to registry.ts.
 */
describe('boilerplate scaffolds — syntax (esbuild transform)', () => {
  const files: Array<{ boilerplate: string; path: string; content: string }> = [];
  for (const [boilerplate, meta] of Object.entries(BOILERPLATE_REGISTRY)) {
    for (const f of meta.augmentFiles ?? []) {
      if (/\.tsx?$/.test(f.path)) files.push({ boilerplate, path: f.path, content: f.content });
    }
  }

  it('has scaffold files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('$boilerplate · $path parses', ({ path, content }) => {
    expect(() =>
      transformSync(content, {
        loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
        // syntax-only: don't resolve imports or check types
      }),
    ).not.toThrow();
  });
});

/**
 * F7 / Incident C6 (foundation-green-guarantee-plan.md, project_pipeline_debug_dossier.md) —
 * the syntax-only esbuild pass above CANNOT catch this class of defect: the canvas-game
 * scaffold's `state-machine.ts` assigned the TEST-ONLY `__force` action's raw `string`
 * straight into `GameState.status` (typed `GameStatus`, a narrow union), so a freshly
 * scaffolded app failed `tsc --noEmit` / `next build` with ZERO story code — every game
 * foundation story inherited a red build until a story widened the type.
 *
 * This guard runs the REAL TypeScript checker (not esbuild) over the scaffold's
 * `types.ts` + `state-machine.ts` pair, in-memory, so a regression (either widening
 * `GameStatus` back open or re-introducing an unchecked `string` assignment) fails the
 * unit suite instead of silently shipping in registry.ts.
 */
describe('boilerplate scaffolds — canvas-game state-machine typechecks (ts compiler API)', () => {
  const canvasGameFiles = BOILERPLATE_REGISTRY['nextjs-canvas-game'].augmentFiles ?? [];
  const typesFile = canvasGameFiles.find((f) => f.path === 'src/game/types.ts');
  const stateMachineFile = canvasGameFiles.find((f) => f.path === 'src/game/state-machine.ts');

  it('scaffold ships both types.ts and state-machine.ts', () => {
    expect(typesFile).toBeDefined();
    expect(stateMachineFile).toBeDefined();
  });

  it('state-machine.ts compiles cleanly against the narrow GameStatus union', () => {
    if (!typesFile || !stateMachineFile) throw new Error('scaffold files missing (see prior test)');

    // Virtual directory lives under the real repo root so TypeScript's module
    // resolution, walking UP from this (non-existent) directory looking for
    // node_modules, lands on the repo's real node_modules/react + @types/react —
    // no fixture files ever touch disk.
    const virtualDir = nodePath.join(process.cwd(), '__scaffold_typecheck__', 'src', 'game');
    const typesPath = nodePath.join(virtualDir, 'types.ts');
    const stateMachinePath = nodePath.join(virtualDir, 'state-machine.ts');
    const virtualContents = new Map<string, string>([
      [typesPath, typesFile.content],
      [stateMachinePath, stateMachineFile.content],
    ]);

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2017,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['lib.dom.d.ts', 'lib.esnext.d.ts'],
    };

    const realHost = ts.createCompilerHost(compilerOptions, /* setParentNodes */ true);
    const host: ts.CompilerHost = {
      ...realHost,
      fileExists: (fileName) => virtualContents.has(fileName) || realHost.fileExists(fileName),
      readFile: (fileName) => virtualContents.get(fileName) ?? realHost.readFile(fileName),
      // The virtual directory never exists on real disk — without this override
      // module resolution short-circuits on `directoryExists(virtualDir) === false`
      // before ever calling `fileExists` for the relative `./types` import.
      directoryExists: (dirName) =>
        dirName === virtualDir || (realHost.directoryExists?.(dirName) ?? true),
      getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const virtual = virtualContents.get(fileName);
        if (virtual !== undefined) {
          return ts.createSourceFile(
            fileName,
            virtual,
            languageVersionOrOptions,
            true,
            ts.ScriptKind.TS,
          );
        }
        return realHost.getSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        );
      },
    };

    const program = ts.createProgram([stateMachinePath], compilerOptions, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);

    const formatted = diagnostics
      .map((d) => ts.formatDiagnosticsWithColorAndContext([d], host))
      .join('\n');
    expect(formatted, `expected zero type errors in the bare scaffold:\n${formatted}`).toBe('');
  });
});
