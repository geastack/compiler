import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { createCommonJsRequireCensus } from './commonjs-require.js'
import { createLayoutTypeResolver } from './structural-layout-type.js'

const programOf = (text: string) => {
  const name = '/frontend-query-reuse.ts'
  const options: ts.CompilerOptions = { noLib: true, strict: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...rest) =>
    resolve(file) === resolve(name) ? ts.createSourceFile(file, text, language, true) : read(file, language, ...rest)
  const program = ts.createProgram([name], options, host)
  const source = program.getSourceFile(name)
  assert.ok(source)
  return { checker: program.getTypeChecker(), source }
}

test('without installed CommonJS wrapper identities ordinary code requires no checker queries', () => {
  const { checker, source } = programOf('function require(name: string) { return name }; const alias = require; alias("local");')
  const guarded = new Proxy(checker, {
    get: () => {
      throw new Error('no wrapper declarations require no identity queries')
    }
  })
  const census = createCommonJsRequireCensus(guarded, [source], new Map())
  let calls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      assert.equal(census.statusOf(node.expression), 'ordinary')
      calls++
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(calls, 1)
})

test('layout answers are reused within a resolver and kept separate across checker snapshots', () => {
  for (const text of ['const value = 42; value;', 'const value = "text"; value;']) {
    const { checker, source } = programOf(text)
    const statement = source.statements[1]
    assert.ok(statement && ts.isExpressionStatement(statement))
    let queries = 0
    const counted = new Proxy(checker, {
      get: (target, key) =>
        key === 'getTypeAtLocation'
          ? (node: ts.Node) => {
              queries++
              return checker.getTypeAtLocation(node)
            }
          : Reflect.get(target, key)
    })
    const resolve = createLayoutTypeResolver(counted)
    const first = resolve(statement.expression)
    const afterFirst = queries
    assert.ok(afterFirst > 0)
    assert.equal(resolve(statement.expression), first)
    assert.equal(queries, afterFirst)
    assert.equal(createLayoutTypeResolver(counted)(statement.expression), first)
    assert.ok(queries > afterFirst)
  }
})

const commonJsCensusAsks = (resolutions: number): number => {
  const wrapper = resolve('test/fixtures/commonjs-module-record/host-wrapper.d.ts')
  const name = resolve('/frontend-query-reuse-commonjs.ts')
  const text = [
    'function validate(data: unknown): boolean { return data === validate }',
    'const first = validate',
    'const second = first',
    'module.exports = second',
    ...Array.from({ length: resolutions }, (_, index) => `exports.check${index} = second`)
  ].join('\n')
  const options: ts.CompilerOptions = { strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...rest) =>
    resolve(file) === name ? ts.createSourceFile(file, text, language, true) : read(file, language, ...rest)
  const program = ts.createProgram([wrapper, name], options, host)
  const source = program.getSourceFile(name)
  assert.ok(source)
  const checker = program.getTypeChecker()
  const asked = new Map<ts.Node, number>()
  const counted = new Proxy(checker, {
    get: (target, key) =>
      key === 'getSymbolAtLocation'
        ? (node: ts.Node) => {
            asked.set(node, (asked.get(node) ?? 0) + 1)
            return checker.getSymbolAtLocation(node)
          }
        : Reflect.get(target, key)
  })
  const globals = new Map(
    (['require', 'exports', 'module'] as const).map((global) => [global, { global, declarationName: global, declarationFileName: wrapper }])
  )
  createCommonJsRequireCensus(counted, [source], globals)
  return Math.max(...asked.values())
}

test('CommonJS function-value resolution asks the checker about a node a bounded number of times', () => {
  // fast-json-stringify's generated validator reaches the same names from
  // thousands of resolutions, and each checker ask re-checks the receiver: the
  // asks per node must not grow with the number of resolutions that reach it.
  assert.equal(commonJsCensusAsks(8), commonJsCensusAsks(2))
})
