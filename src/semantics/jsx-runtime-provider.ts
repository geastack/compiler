import ts from '#typescript'
import type { CompiledProgram } from './program.js'

/** Project-selected automatic JSX runtime, using the Program's existing module
 * authority. This does not assign any rendering semantics to that provider. */
export const createJsxRuntimeModuleResolver =
  (
    compiled: Pick<CompiledProgram, 'program' | 'runtimeModuleTargetOf' | 'sourceFileOf'>
  ): ((containingFile: string) => ts.SourceFile | null) =>
  (containingFile) => {
    const options = compiled.program.getCompilerOptions()
    const source = compiled.sourceFileOf(containingFile)
    // Per-file overrides require their own frontend projection. Refusing an
    // ambiguous witness is preferable to attributing it to the project provider.
    if (source === null || /@jsx(?:ImportSource|Runtime)\b/.test(source.text)) return null
    if ((options.jsx !== ts.JsxEmit.ReactJSX && options.jsx !== ts.JsxEmit.ReactJSXDev) || !options.jsxImportSource) return null
    const specifier = `${options.jsxImportSource}/${options.jsx === ts.JsxEmit.ReactJSXDev ? 'jsx-dev-runtime' : 'jsx-runtime'}`
    const target = compiled.runtimeModuleTargetOf(specifier, containingFile, 'import')
    return target === null ? null : compiled.sourceFileOf(target)
  }
