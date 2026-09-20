import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { attachStatedModuleSet, exportIsUnimported } from './targets.js'

const libraryPath = resolve('test/fixtures/export-imports-library.ts')
const entryPath = resolve('test/fixtures/export-imports-entry.ts')
const barrelPath = resolve('test/fixtures/export-imports-barrel.ts')
const library = 'function inner() {} function outer() {} export { outer, inner }; export function direct() {}'

/** Names of the library's exports nothing imports, or null for a program
 * whose module set was never stated. */
const unimportedExports = (entrySource: string, barrelSource: string | null = null, stated = true): readonly string[] | null => {
  const contents = new Map([
    [libraryPath, library],
    [entryPath, entrySource]
  ])
  if (barrelSource !== null) contents.set(barrelPath, barrelSource)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = contents.get(resolve(name))
    return text === undefined ? original(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => ({ resolvedFileName: resolve(dirname(containingFile), `${name}.ts`), extension: ts.Extension.Ts }))
  const program = ts.createProgram([...contents.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = [...contents.keys()].map((name) => program.getSourceFile(name)!)
  const flow = indexValueFlow(checker, files, wholeProgram)
  if (stated) attachStatedModuleSet(flow, { files, entries: [files[1]!] })
  const libraryFile = files[0]!
  const candidates: (ts.ExportSpecifier | ts.Declaration)[] = []
  for (const statement of libraryFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
      candidates.push(...statement.exportClause.elements)
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      candidates.push(statement)
  }
  if (!stated) return candidates.some((candidate) => exportIsUnimported(checker, flow, candidate)) ? [] : null
  return candidates
    .filter((candidate) => exportIsUnimported(checker, flow, candidate))
    .map((candidate) => (ts.isExportSpecifier(candidate) ? candidate.name.text : ts.getNameOfDeclaration(candidate)!.getText()))
}

test('an export no import reaches is unimported in a stated module set', () => {
  assert.deepEqual(unimportedExports('import { outer } from "./export-imports-library"; outer();'), ['inner', 'direct'])
  assert.deepEqual(unimportedExports('import { outer as renamed, direct } from "./export-imports-library"; renamed(); direct();'), [
    'inner'
  ])
  assert.deepEqual(unimportedExports('import type { outer } from "./export-imports-library";'), ['outer', 'inner', 'direct'])
})

test('namespace, re-export, dynamic and unstated module sets keep every export published', () => {
  assert.equal(unimportedExports('import { outer } from "./export-imports-library"; outer();', null, false), null)
  assert.deepEqual(unimportedExports('import * as library from "./export-imports-library"; library.outer();'), [])
  assert.deepEqual(unimportedExports('import("./export-imports-library");'), [])
  assert.deepEqual(unimportedExports('declare const name: string; import(name);'), [])
  assert.deepEqual(
    unimportedExports('import { inner } from "./export-imports-barrel"; inner();', 'export { inner } from "./export-imports-library";'),
    ['outer', 'direct']
  )
  // A re-export is itself a publication, whether or not its own name is imported.
  assert.deepEqual(unimportedExports('export {};', 'export { inner as alias } from "./export-imports-library";'), ['outer', 'direct'])
  assert.deepEqual(unimportedExports('export {};', 'export * from "./export-imports-library";'), [])
  assert.deepEqual(unimportedExports('export * from "./export-imports-library";'), [])
})
