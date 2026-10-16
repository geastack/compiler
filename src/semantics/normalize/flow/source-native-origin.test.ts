import { attachClosedScriptScope } from './targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { sourceNativeOriginIsClosed } from './source-native-origin.js'

const origin = (body: string): boolean => {
  const entry = resolve('test/fixtures/native-origin-proof.ts')
  const source = `interface Native { readonly size:number }; declare const input:Native; declare const opaque:any;
    declare function consume(value:unknown):void; ${body}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, version, ...rest) =>
    resolve(file) === entry ? ts.createSourceFile(file, source, version, true) : original(file, version, ...rest)
  const program = ts.createProgram([entry], options, host),
    checker = program.getTypeChecker(),
    file = program.getSourceFile(entry)!
  const input = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'input')!
  const symbol = checker.getSymbolAtLocation(input.name)
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const terminal = flow.calls
    .filter((site) => ts.isCallExpression(site.call) && ts.isIdentifier(site.call.expression) && site.call.expression.text === 'consume')
    .at(-1)!.call as ts.CallExpression
  return sourceNativeOriginIsClosed(
    checker,
    flow,
    terminal.arguments[0]!,
    (node) => ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol
  )
}

test('exact installed root and closed aliases retain native origin', () => {
  assert.equal(origin('consume(input)'), true, 'root')
  assert.equal(origin('const alias=input;consume(alias)'), true, 'alias')
  assert.equal(origin('const alias=input as unknown as Native;consume(alias)'), true, 'cast alias')
  assert.equal(origin('consume(true ? input : input)'), true)
})
for (const expression of [
  '{} as Native',
  'opaque as Native',
  '({get value(){return input}}).value',
  '({value:input}).value',
  '(()=>input)()',
  'true ? input : opaque'
])
  test(`annotation, property evaluation or opaque transport does not create native origin: ${expression}`, () =>
    assert.equal(origin(`consume(${expression})`), false))
