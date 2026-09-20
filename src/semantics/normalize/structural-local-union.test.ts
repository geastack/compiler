import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createLocalUnionResolver } from './structural-local-union.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'

const resolveLocal = (body: string) => {
  const entry = resolve('test/runtime/structural-local-value.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strictNullChecks: true, noLib: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `declare function source(): any; declare function other(): any; ${body}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const table = createStructuralTypeTable()
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const dynamic = table.intern({ kind: 'primitive', primitive: 'any' })
  const factAt = (node: ts.Node) =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      ? node.expression.text === 'source'
        ? number
        : node.expression.text === 'other'
          ? string
          : dynamic
      : null
  const lookup = createLocalUnionResolver(
    checker,
    table,
    emptyParameterBindingCensus,
    indexValueFlow(checker, [file], wholeProgram),
    (node) => factAt(node) ?? dynamic,
    factAt
  )
  const statement = file.statements.find(ts.isVariableStatement)!
  const declaration = statement.declarationList.declarations[0]!
  const read = (file.statements[file.statements.length - 1] as ts.ExpressionStatement).expression
  return { declared: lookup(declaration), read: lookup(read) }
}

test('a complete native source refinement is shared by local declarations and reads', () => {
  const result = resolveLocal('let value = source(); value = source(); value;')
  assert.ok(result.declared)
  assert.equal(result.read, result.declared)
})

test('mixed and unresolved writes prevent partial source refinement', () => {
  for (const body of [
    'let value = source(); value = other(); value;',
    'let value = source(); value = JSON.parse("0"); value;',
    'let value = source(); value = 7; value;',
    'let value: any = source(); value;'
  ]) {
    const result = resolveLocal(body)
    assert.equal(result.declared, null, body)
    assert.equal(result.read, null, body)
  }
})
