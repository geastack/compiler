import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { presentReturnTypeOf } from './optional-chain.js'

const source = ts.createSourceFile(
  'optional-call-signatures.ts',
  `declare const host: {
    effect(): void
    absent(): undefined
    nullable(): number | null
    optional(): number | undefined
    value(): number
    generic<T>(value: T): T
    overloaded(value: number): void
    overloaded(value: string): string
  } | null
  host?.effect()
  host?.absent()
  host?.nullable()
  host?.optional()
  host?.value()
  host?.generic(42)
  host?.generic(undefined)
  host?.overloaded(1)
  host?.overloaded('x')`,
  ts.ScriptTarget.Latest,
  true
)
const options: ts.CompilerOptions = { strict: true, noLib: true }
const host = ts.createCompilerHost(options)
host.getSourceFile = (name) => (resolve(name) === resolve(source.fileName) ? source : undefined)
const program = ts.createProgram([source.fileName], options, host)
const checker = program.getTypeChecker()
const calls = source.statements
  .filter(ts.isExpressionStatement)
  .map((statement) => statement.expression)
  .filter(ts.isCallExpression)

test('optional calls retain void callable ABI and remove only proven chain nullishness', () => {
  const expected = [
    'void',
    'undefined',
    'number | null | undefined',
    'number | undefined',
    'number',
    '42 | undefined',
    'undefined',
    'void',
    'string'
  ]
  assert.equal(calls.length, expected.length)
  for (const [index, call] of calls.entries()) {
    const signature = checker.getResolvedSignature(call)
    assert.ok(signature)
    assert.equal(checker.typeToString(presentReturnTypeOf(checker, signature)), expected[index], call.getText(source))
  }
})
