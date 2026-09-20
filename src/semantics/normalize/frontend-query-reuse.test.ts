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
