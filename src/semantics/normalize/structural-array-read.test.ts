import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { structuralArrayReadAt } from './structural-array-read.js'

const readSymbolIndex = (body: string, indexed = true) => {
  const entry = resolve('test/runtime/native-symbol-property-identity.runtime.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strictNullChecks: true, noLib: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, body, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const node = (file.statements[file.statements.length - 1] as ts.ExpressionStatement).expression
  const table = createStructuralTypeTable()
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const source = table.intern({
    kind: 'object',
    members: [],
    membersDropped: false,
    index: indexed ? [{ key: 'symbol', value: number, readonly: false }] : []
  })
  const result = structuralArrayReadAt(program.getTypeChecker(), table, source, node)
  return result === null ? null : table.get(result).shape
}

test('an erased symbol index read recovers native value and missing-key absence', () => {
  const shape = readSymbolIndex('declare const key: symbol; declare const object: any; object[key];')
  assert.equal(shape?.kind, 'union')
  if (shape?.kind === 'union') assert.equal(shape.members.length, 2)
})

test('symbol recovery preserves stated reads and refuses absent key-domain authority', () => {
  assert.equal(readSymbolIndex('declare const key: symbol; declare const object: { [key: symbol]: string }; object[key];'), null)
  assert.equal(readSymbolIndex('declare const key: symbol; declare const object: any; object[key];', false), null)
  assert.equal(readSymbolIndex('declare const key: string; declare const object: any; object[key];'), null)
})
