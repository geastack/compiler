import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { declarationOverlayTransform } from './declaration-overlay-transform.js'

const fileName = resolve('test/fixtures/declaration-constant-fields.js')
const declarationFileName = resolve('test/fixtures/declaration-constant-fields.d.ts')
const original = readFileSync(fileName, 'utf8')
const overlay = (text = original, declared = declarationFileName): string =>
  declarationOverlayTransform({ fileName, declarationFileName: declared, text }) ?? text

const inspect = (text: string) => {
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext }
  const host = ts.createCompilerHost(options, true)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (path, version, onError, fresh) =>
    resolve(path) === resolve(fileName)
      ? ts.createSourceFile(path, text, version, true, ts.ScriptKind.JS)
      : read(path, version, onError, fresh)
  const program = ts.createProgram([fileName], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(fileName)!
  const fields: ts.Type[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'mode') fields.push(checker.getTypeAtLocation(node))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { program, checker, file, fields }
}

test('a declared union module resolves constants named by source JSDoc on both stores and reads', () => {
  const before = inspect(original)
  assert.ok(before.fields.some((field) => (field.flags & ts.TypeFlags.Any) !== 0))
  const text = overlay()
  assert.match(text, /@import \{ ModeB \} from ['"]\.\/declaration-constant-values\.js['"]/)
  const after = inspect(text)
  assert.ok(after.fields.length > 0)
  assert.ok(
    after.fields.every((field) => (field.isUnion() ? field.types : [field]).every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0)),
    after.fields.map((field) => after.checker.typeToString(field)).join(', ')
  )
  assert.deepEqual(after.program.getSemanticDiagnostics(after.file), [])
  const printer = ts.createPrinter({ removeComments: true })
  assert.equal(printer.printFile(after.file), printer.printFile(before.file))
  assert.equal(overlay(text), text)
})

test('two imported modules exporting the missing name do not license a choice', () => {
  const text = overlay(original, resolve('test/fixtures/declaration-constant-ambiguous.d.ts'))
  assert.doesNotMatch(text, /@import \{ ModeB \}/)
  assert.ok(inspect(text).fields.some((field) => (field.flags & ts.TypeFlags.Any) !== 0))
})

test('a source binding keeps its own type instead of borrowing an imported homonym', () => {
  const text = overlay(`const ModeB = 'nine'\n${original}`)
  assert.doesNotMatch(text, /@import \{ ModeB \}/)
  const { fields } = inspect(text)
  assert.ok(fields.every((field) => field.isUnion() && field.types.some((part) => (part.flags & ts.TypeFlags.StringLike) !== 0)))
})

test('a source JSDoc typedef is already a binding for its type name', () => {
  const text = overlay(`/** @typedef {string} ModeB */\n${original}`)
  assert.doesNotMatch(text, /@import \{ ModeB \}/)
  const { fields } = inspect(text)
  assert.ok(fields.every((field) => field.isUnion() && field.types.some((part) => (part.flags & ts.TypeFlags.StringLike) !== 0)))
})
