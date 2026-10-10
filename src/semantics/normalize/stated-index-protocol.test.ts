import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { narrowsOnlyUnstatedPositions } from './derived-expression-type.js'

const entry = resolve('test/fixtures/stated-index-protocol.ts')
const source = `
  export {}
  interface Document { [key: string]: any }
  interface Options { authSource?: string; retryWrites?: boolean }
  type DocumentAlias = Record<string, any>
  interface Strings { [key: string]: string }
  interface Numbers { [key: number]: string }
`
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
const host = ts.createCompilerHost(options)
const original = host.getSourceFile.bind(host)
host.getSourceFile = (name, version, ...rest) =>
  resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
const program = ts.createProgram([entry], options, host)
const checker = program.getTypeChecker()
const file = program.getSourceFile(entry)!
const named = (name: string): ts.Type => {
  const declaration = file.statements.find(
    (statement) => (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name
  )
  assert.ok(declaration)
  return checker.getTypeAtLocation(declaration)
}

test('mutually assignable optional fields do not replace a declared arbitrary string-key protocol', () => {
  const document = named('Document')
  const record = named('Options')
  assert.equal(checker.isTypeAssignableTo(document, record), true)
  assert.equal(checker.isTypeAssignableTo(record, document), true)
  assert.equal(narrowsOnlyUnstatedPositions(checker, file, document, record), false)
})

test('an index alias and a concrete entry carrier retain the stated index protocol', () => {
  const document = named('Document')
  assert.equal(narrowsOnlyUnstatedPositions(checker, file, document, named('DocumentAlias')), true)
  assert.equal(narrowsOnlyUnstatedPositions(checker, file, document, named('Strings')), true)
  assert.equal(narrowsOnlyUnstatedPositions(checker, file, document, named('Numbers')), false)
})
