import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createLocalUnionResolver } from './structural-local-union.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'

const resolveLocal = (body: string, sourceCalls = false, sourceReturn = 'any') => {
  const entry = resolve('test/runtime/structural-local-value.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strictNullChecks: true, noLib: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `declare function source(): ${sourceReturn}; declare function other(): any; ${body}`, version, true)
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
    (node) => factAt(node) ?? (ts.isNumericLiteral(node) ? number : dynamic),
    sourceCalls ? () => null : factAt,
    sourceCalls ? factAt : () => null
  )
  const statement = file.statements.find(ts.isVariableStatement)!
  const declaration = statement.declarationList.declarations[0]!
  const read = (file.statements[file.statements.length - 1] as ts.ExpressionStatement).expression
  return { declared: lookup(declaration), read: lookup(read), table }
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

test('an authenticated executable call result joins every actual writer of an inferred local', () => {
  for (const body of [
    'const value = other(); value;',
    'let value = other(); value = 7; value;',
    'let value = other(); value = source(); value;',
    'let value; value = other(); value;'
  ]) {
    const result = resolveLocal(body, true)
    assert.ok(result.declared, body)
    assert.equal(result.read, result.declared, body)
    const shape = result.table.get(result.declared).shape
    assert.equal(shape.kind, 'union')
    if (shape.kind !== 'union') continue
    const members = shape.members.map((member) => result.table.get(member).shape)
    assert.ok(members.some((member) => member.kind === 'primitive' && member.primitive === 'string'))
    if (body.includes('value = 7') || body.includes('value = source'))
      assert.ok(members.some((member) => member.kind === 'primitive' && member.primitive === 'number'))
    if (body.includes('let value;')) assert.ok(members.some((member) => member.kind === 'primitive' && member.primitive === 'undefined'))
  }
})

test('source-call domains retain genuine dynamic writers and reject incomplete or annotated storage', () => {
  const dynamic = resolveLocal('let value = other(); value = JSON.parse("0"); value;', true)
  assert.ok(dynamic.declared)
  const shape = dynamic.table.get(dynamic.declared).shape
  assert.equal(shape.kind, 'union')
  if (shape.kind === 'union')
    assert.ok(
      shape.members.some((member) => {
        const field = dynamic.table.get(member).shape
        return field.kind === 'primitive' && field.primitive === 'any'
      })
    )
  for (const body of ['let value: any = other(); value;', 'let value = other(); value++; value;']) {
    const result = resolveLocal(body, true)
    assert.equal(result.declared, null, body)
    assert.equal(result.read, null, body)
  }
})

test('a different executable return prevents stale checker nullish narrowing', () => {
  const result = resolveLocal('const value = source(); value;', true, 'undefined')
  assert.ok(result.declared)
  assert.ok(result.read)
  assert.equal(result.read, result.declared)
  assert.notDeepEqual(result.table.get(result.read).shape, { kind: 'primitive', primitive: 'undefined' })
})

test('inferred aliases retain the complete source-call result domain', () => {
  const result = resolveLocal('let value = other(); const alias = value; alias;', true)
  assert.ok(result.declared)
  assert.equal(result.read, result.declared)
})
