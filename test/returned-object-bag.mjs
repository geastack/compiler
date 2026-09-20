import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import ts from 'typescript'
import { wholeProgram } from '../dist/semantics/normalize/reachability.js'
import { indexValueFlow } from '../dist/semantics/normalize/flow/value-flow.js'
import { censusObjectBagBindings } from '../dist/semantics/normalize/object-bag-bindings.js'

test('bag returns do not erase absence, promises, or generators', () => {
  const path = resolve(import.meta.dirname, 'runtime/bag-return-paths.ts')
  const source = [
    'function complete() { const bag = {}; bag.x = 1; return bag }',
    'function partial(flag: boolean) { const bag = {}; bag.x = 1; if (flag) return bag }',
    'function bare(flag: boolean) { const bag = {}; bag.x = 1; if (flag) return; return bag }',
    'async function asynchronous() { const bag = {}; bag.x = 1; return bag }',
    'function* generator() { const bag = {}; bag.x = 1; return bag }'
  ].join('\n')
  const options = { strict: true, target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, ...rest) =>
    resolve(file) === resolve(path) ? ts.createSourceFile(file, source, languageVersion, true) : original(file, languageVersion, ...rest)
  const program = ts.createProgram([path], options, host)
  const file = program.getSourceFile(path)
  const checker = program.getTypeChecker()
  const census = censusObjectBagBindings(checker, [file], wholeProgram, undefined, indexValueFlow(checker, [file], wholeProgram))
  const declarations = file.statements.filter(ts.isFunctionDeclaration)
  assert.ok(census.returnShapeOf(declarations[0]))
  for (const declaration of declarations.slice(1)) assert.equal(census.returnShapeOf(declaration), null, declaration.name.text)
})

test('bag identity requires grounded aliases instead of transient missing types', () => {
  const path = resolve(import.meta.dirname, 'runtime/bag-alias-grounding.js')
  const source = [
    'function fillGrounded(value) { value.member = 1 }',
    'function fillMixed(value) { value.member = 1 }',
    'const grounded = {}; fillGrounded(grounded)',
    'function replace(input) { let mixed = {}; fillMixed(mixed); mixed = input; return mixed }'
  ].join('\n')
  const options = { strict: true, allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, ...rest) =>
    resolve(file) === resolve(path)
      ? ts.createSourceFile(file, source, languageVersion, true, ts.ScriptKind.JS)
      : original(file, languageVersion, ...rest)
  const program = ts.createProgram([path], options, host)
  const file = program.getSourceFile(path)
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const census = censusObjectBagBindings(checker, [file], wholeProgram, undefined, flow)
  const groundedStatement = file.statements.find(
    (statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText() === 'grounded'
  )
  const replace = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'replace')
  const grounded = groundedStatement.declarationList.declarations[0]
  const mixedStatement = replace.body.statements.find(ts.isVariableStatement)
  const mixed = mixedStatement.declarationList.declarations[0]
  assert.ok(census.shapeForOwner(grounded), 'a direct call-argument alias remains grounded in the bag allocation')
  assert.equal(census.shapeForOwner(mixed), null, 'an untyped competing write is pending evidence, never alias permission')
  assert.equal(census.refusalOf(mixed.initializer), 'bag:write-not-proven-alias')
})

test('returned inferred bags retain their native storage through cached factories', () => {
  const root = resolve(import.meta.dirname, '..')
  const result = compile({
    rootFileNames: [resolve(root, 'test/runtime/returned-object-bag.js')],
    projectFileName: resolve(root, 'test/runtime/inferred-return-union.tsconfig.json'),
    javaScriptSources: true
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  assert.doesNotMatch(result.source, /gea_cpp_value|gea::Value (?:gea_|v\d|b\d)/)
  const binary = resolve(root, `measurements/returned-object-bag${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { __gea_top_level(); }\n`
    }
  )
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), '3 4 true\n9')
})
