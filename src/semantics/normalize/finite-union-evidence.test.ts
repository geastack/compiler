import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { disjointArmsOf, disjointUnionTypeOf } from './derived-expression-type.js'

const withTypes = (source: string, check: (checker: ts.TypeChecker, types: readonly ts.Type[]) => void): void => {
  const entry = resolve('test/fixtures/finite-union-evidence.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const types = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations.map((declaration) => checker.getTypeAtLocation(declaration.name)))
  check(checker, types)
}

test('finite write evidence keeps all five, ten and twenty-seven distinct shapes', () => {
  for (const size of [5, 10, 27]) {
    const source = Array.from({ length: size }, (_, index) => `const value${index} = { field${index}: ${index} };`).join('\n')
    withTypes(source, (checker, types) => {
      const members = disjointArmsOf(checker, types)
      assert.equal(members?.length, size)
      const union = disjointUnionTypeOf(checker, types)
      assert.ok(union?.isUnion())
      assert.equal(union.types.length, size)
      for (const type of types) assert.ok(checker.isTypeAssignableTo(type, union))
    })
  }
})

test('larger finite sets still reject missing evidence and overlapping alternatives', () => {
  withTypes('const a = { a: 1 }; const b = { b: 2 }; const c = { c: 3 }; const d = { d: 4 }; const e = { e: 5 };', (checker, types) => {
    for (const missing of [checker.getAnyType(), checker.getUnknownType()]) {
      assert.equal(disjointArmsOf(checker, [...types, missing]), null)
    }
    assert.equal(disjointArmsOf(checker, [...types, types[0]!])?.length, types.length)
  })
  withTypes('const base = { a: 1 }; const extension = { a: 1, b: 2 };', (checker, types) => {
    assert.equal(disjointArmsOf(checker, types), null)
  })
})

test('nullable write unions are flattened before disjointness is checked', () => {
  withTypes(
    'let numberOrUndefined: number | undefined; let numberValue: number; let stringOrNull: string | null; let stringValue: string; let booleanValue: boolean;',
    (checker, types) => {
      const union = disjointUnionTypeOf(checker, types)
      assert.ok(union?.isUnion())
      assert.deepEqual(union.types.map((type) => checker.typeToString(type)).sort(), [
        'false',
        'null',
        'number',
        'string',
        'true',
        'undefined'
      ])
      assert.ok(types.every((type) => checker.isTypeAssignableTo(type, union)))
    }
  )
})

test('flattening retains no-evidence vetoes and subtype overlap refusals', () => {
  withTypes('let known: number | undefined; let dynamic: any;', (checker, types) => {
    assert.equal(disjointUnionTypeOf(checker, types), null)
  })
  withTypes(
    'interface Base { base: number }; interface Derived extends Base { extra: string }; let base: Base; let derived: Derived;',
    (checker, types) => {
      assert.equal(disjointArmsOf(checker, types), null)
      assert.equal(disjointUnionTypeOf(checker, types), null)
    }
  )
})
