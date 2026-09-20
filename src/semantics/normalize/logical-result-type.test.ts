import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { keptLeftPartTypeOf, logicalResultTypeOf } from './logical-result-type.js'
import { derivedExpressionType } from './derived-expression-type.js'

const entry = resolve('test/runtime/logical-object-union-falsy-absence.ts')
const source = `
class Marker { isMarker = true }
declare const input: Marker | null | undefined;
declare const flag: boolean;
const result = input && flag;
type Present = Marker;
type Nullable = Marker | null | undefined;
type Mixed = false | 0 | '' | Marker;
`
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true }
const host = ts.createCompilerHost(options, true)
const original = host.getSourceFile.bind(host)
host.getSourceFile = (name, version, onError, fresh) =>
  resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, onError, fresh)
const program = ts.createProgram({ rootNames: [entry], options, host })
const checker = program.getTypeChecker()
const file = program.getSourceFile(entry)!
const types = new Map(file.statements.filter(ts.isTypeAliasDeclaration).map((alias) => [alias.name.text, checker.getTypeAtLocation(alias)]))
const type = (name: string): ts.Type => {
  const value = types.get(name)
  assert.ok(value, name)
  return value
}
const members = (value: ts.Type | null): string[] => {
  assert.ok(value)
  return [...new Set((value.isUnion() ? value.types : [value]).map((part) => checker.typeToString(part)))].sort()
}

test('logical results retain null and undefined but exclude a truthy class from the false arm', () => {
  assert.deepEqual(members(logicalResultTypeOf(checker, '&&', type('Nullable'), checker.getBooleanType())), [
    'false',
    'null',
    'true',
    'undefined'
  ])
  for (const operator of ['||', '??'] as const)
    assert.deepEqual(members(logicalResultTypeOf(checker, operator, type('Nullable'), checker.getStringType())), ['Marker', 'string'])
})

test('unreachable alternatives do not add types and falsy literals preserve their values', () => {
  assert.deepEqual(members(logicalResultTypeOf(checker, '||', type('Present'), checker.getAnyType())), ['Marker'])
  assert.deepEqual(members(logicalResultTypeOf(checker, '&&', checker.getFalseType(), checker.getAnyType())), ['false'])
  assert.deepEqual(members(logicalResultTypeOf(checker, '&&', type('Mixed'), checker.getBooleanType())), ['""', '0', 'false', 'true'])
  assert.deepEqual(members(logicalResultTypeOf(checker, '??', type('Mixed'), checker.getAnyType())), ['""', '0', 'Marker', 'false'])
})

test('numbers retain NaN and an uncertain operand cannot be laundered into a typed result', () => {
  assert.deepEqual(members(logicalResultTypeOf(checker, '&&', checker.getNumberType(), checker.getBooleanType())), [
    'false',
    'number',
    'true'
  ])
  for (const operator of ['&&', '||', '??'] as const) {
    assert.deepEqual(members(logicalResultTypeOf(checker, operator, checker.getAnyType(), checker.getNumberType())), ['any'])
    assert.deepEqual(members(logicalResultTypeOf(checker, operator, checker.getUnknownType(), checker.getNumberType())), ['unknown'])
  }
})

test('all expression consumers receive the shared logical result instead of the widest operand', () => {
  const statement = file.statements.find(
    (node) => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText() === 'result'
  )
  assert.ok(statement && ts.isVariableStatement(statement))
  const expression = statement.declarationList.declarations[0]?.initializer
  assert.ok(expression)
  const result = derivedExpressionType(checker, expression, (operand) => checker.getTypeAtLocation(operand))
  assert.deepEqual(members(result), ['false', 'null', 'true', 'undefined'])
})

// The left half alone is what a caller holding an operand carrier the checker
// disagrees with needs: it unions that against its OWN right-hand answer
// instead of re-asking the checker at the whole expression (see
// `producers/computations.ts`'s `&&` case, and the three.js app's `!! fog &&
// fog.isFogExp2`, where the checker types the right operand `any` and the
// member census types it `boolean | undefined`).
test('the kept left half of && is the falsy arms, and is absent for an always-truthy guard', () => {
  // `obj && obj.x` keeps NOTHING from `obj`: the expression is the right
  // operand, unqualified. Answering `Marker` here instead would union a class
  // carrier into whatever `obj.x` is.
  assert.equal(keptLeftPartTypeOf(checker, '&&', type('Present')), null)
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '&&', type('Nullable'))), ['null', 'undefined'])
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '&&', checker.getBooleanType())), ['false'])
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '&&', type('Mixed'))), ['""', '0', 'false'])
})

test('the kept left half of || and ?? drops exactly what each operator discards', () => {
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '||', type('Nullable'))), ['Marker'])
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '??', type('Nullable'))), ['Marker'])
  // `??` discards only the nullish arms, so `false`/`0`/`''` survive it while
  // `||` drops them -- the one place the two operators' left halves differ.
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '??', type('Mixed'))), ['""', '0', 'Marker', 'false'])
  assert.deepEqual(members(keptLeftPartTypeOf(checker, '||', type('Mixed'))), ['Marker'])
  assert.equal(keptLeftPartTypeOf(checker, '||', checker.getFalseType()), null)
})
