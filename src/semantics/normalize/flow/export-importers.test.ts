import assert from 'node:assert/strict'
import test from 'node:test'
import { basename, dirname, resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram, type ProgramReachability } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { attachStatedModuleSet } from './targets.js'
import { inProgramImportReferencesOf } from './export-importers.js'

const path = (name: string): string => resolve(`test/fixtures/export-importers-${name}.ts`)
const LIBRARY = 'function inner() {} function outer() {} export { outer, inner }; export function direct() {}'
const FROM = (name: string): string => `"./export-importers-${name}"`

/** For each library export, its in-program import references as
 * `module:text` (sorted), or null when its exposure is open. */
const importers = (
  sources: Readonly<Record<string, string>>,
  entries: readonly string[] = ['entry'],
  stated = true,
  /** Modules the program never evaluates: loaded by the checker, reached by nothing. */
  dead: readonly string[] = []
): Record<string, readonly string[] | null> => {
  const contents = new Map([[path('library'), LIBRARY], ...Object.entries(sources).map(([name, text]) => [path(name), text] as const)])
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = contents.get(resolve(name))
    return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => ({ resolvedFileName: resolve(dirname(containingFile), `${name}.ts`), extension: ts.Extension.Ts }))
  const program = ts.createProgram([...contents.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = [...contents.keys()].map((name) => program.getSourceFile(name)!)
  const flow = indexValueFlow(checker, files, wholeProgram)
  const deadFiles = new Set(dead.map((name) => program.getSourceFile(path(name))!))
  const reachable: ProgramReachability = {
    statementsOf: (file) => (deadFiles.has(file) ? [] : file.statements),
    memberIsPruned: () => false,
    classIsLayoutOnly: () => false
  }
  if (stated) attachStatedModuleSet(flow, { files, entries: entries.map((name) => program.getSourceFile(path(name))!), reachable })
  const answer = (subject: ts.ExportSpecifier | ts.Declaration): readonly string[] | null =>
    inProgramImportReferencesOf(checker, flow, subject)
      ?.map((reference) => `${basename(reference.getSourceFile().fileName, '.ts').replace('export-importers-', '')}:${reference.getText()}`)
      .sort() ?? null
  const result: Record<string, readonly string[] | null> = {}
  for (const statement of files[0]!.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
      for (const element of statement.exportClause.elements) result[element.name.text] = answer(element)
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      result[statement.name!.text] = answer(statement)
  }
  return result
}

test('named, renamed and default-free imports are enumerated at their importer', () => {
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('library')}; outer(); outer();` }), {
    outer: ['entry:outer', 'entry:outer'],
    inner: [],
    direct: []
  })
  assert.deepEqual(
    importers({ entry: `import { outer as renamed, direct } from ${FROM('library')}; renamed(); direct; let f: typeof renamed;` }),
    { outer: ['entry:renamed'], inner: [], direct: ['entry:direct'] }
  )
})

test('a module the program never evaluates contributes no references', () => {
  // three's `ColorSpaceNode.js`: loaded beside the node materials, reached by
  // nothing, and still importing `ColorManagement` to call it.
  assert.deepEqual(
    importers(
      {
        entry: `import { outer } from ${FROM('library')}; outer();`,
        unused: `import { outer, direct } from ${FROM('library')}; outer(); globalThis.leak = direct;`
      },
      ['entry'],
      true,
      ['unused']
    ),
    { outer: ['entry:outer'], inner: [], direct: [] }
  )
})

test('a namespace import whose every use selects a member statically stays closed', () => {
  assert.deepEqual(importers({ entry: `import * as library from ${FROM('library')}; library.outer(); library["direct"];` }), {
    outer: ['entry:library.outer'],
    inner: [],
    direct: ['entry:library["direct"]']
  })
})

test('re-exports through non-entry modules are followed to their own importers', () => {
  assert.deepEqual(
    importers({
      entry: `import { alias } from ${FROM('barrel')}; alias();`,
      barrel: `export { inner as alias } from ${FROM('library')};`
    }),
    { outer: [], inner: ['entry:alias'], direct: [] }
  )
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('barrel')}; outer();`, barrel: `export * from ${FROM('library')};` }), {
    outer: ['entry:outer'],
    inner: [],
    direct: []
  })
  assert.deepEqual(
    importers({
      entry: `import { again } from ${FROM('middle')}; again();`,
      middle: `import { outer } from ${FROM('library')}; export { outer as again }; outer();`
    }),
    { outer: ['entry:again', 'middle:outer'], inner: [], direct: [] }
  )
})

test('an escaping namespace object opens every export', () => {
  const open = { outer: null, inner: null, direct: null }
  assert.deepEqual(
    importers({ entry: `import * as library from ${FROM('library')}; declare function use(value: unknown): void; use(library);` }),
    open
  )
  assert.deepEqual(importers({ entry: `import * as library from ${FROM('library')}; declare const k: string; (library as any)[k];` }), open)
  assert.deepEqual(importers({ entry: 'export {};', barrel: `export * as library from ${FROM('library')};` }), open)
})

test('export-star and re-export chains that reach an entry are open', () => {
  const open = { outer: null, inner: null, direct: null }
  assert.deepEqual(importers({ entry: `export * from ${FROM('library')};` }), open)
  assert.deepEqual(importers({ entry: `export * from ${FROM('barrel')};`, barrel: `export * from ${FROM('library')};` }), open)
  assert.deepEqual(importers({ entry: `export { outer } from ${FROM('library')};` }), { outer: null, inner: [], direct: [] })
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('library')}; export { outer };` }), {
    outer: null,
    inner: [],
    direct: []
  })
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('library')}; export default outer;` }), {
    outer: null,
    inner: [],
    direct: []
  })
})

test('dynamic import, an entry module, and an unstated module set are open', () => {
  const open = { outer: null, inner: null, direct: null }
  assert.deepEqual(importers({ entry: `import(${FROM('library')});` }), open)
  assert.deepEqual(importers({ entry: 'declare const name: string; import(name);' }), open)
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('library')}; outer();` }, ['entry', 'library']), open)
  assert.deepEqual(importers({ entry: `import { outer } from ${FROM('library')}; outer();` }, ['entry'], false), open)
})
