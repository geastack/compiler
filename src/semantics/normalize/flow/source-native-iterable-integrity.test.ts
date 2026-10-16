import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { indexValueFlow } from './value-flow.js'
import { attachClosedScriptScope } from './targets.js'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { sourceNativeIterableIntegrityOf } from './source-native-iterable-integrity.js'
import type { NativeIterableProvider } from '../../../plugins/native-iterable-providers.js'

const provider: NativeIterableProvider = {
  protocol: 'host-sync-iterable@1',
  receiverNative: 'host::Collection',
  memberModel: 'native-fixed-member',
  iteratorFactory: { kind: 'method', arity: 0, emit: 'host::iterator({receiver})' }
}

const proof = (body: string, closed = true): boolean => {
  const entry = resolve('test/fixtures/native-iterable-integrity.ts')
  const source = `interface Collection { readonly length:number; [Symbol.iterator]():ArrayIterator<object> }
    declare const input:Collection; declare function consume(value:unknown):void; ${body}; consume(input)`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, version, ...rest) =>
    resolve(file) === entry ? ts.createSourceFile(file, source, version, true) : original(file, version, ...rest)
  const program = ts.createProgram([entry], options, host),
    checker = program.getTypeChecker(),
    file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  if (closed) attachClosedScriptScope(flow, { files: new Set([file]) })
  // The compile asks inside a producer's ledger capture, which records the
  // deferred intrinsic obligations an admitted answer carries.
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const declaration = file.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node))!
  const symbol = checker.getSymbolAtLocation(declaration.name)
  const terminals = flow.calls.filter(
    (site) => ts.isCallExpression(site.call) && ts.isIdentifier(site.call.expression) && site.call.expression.text === 'consume'
  )
  const terminal = terminals.at(-1)!.call as ts.CallExpression
  return (
    ledger.capture(() =>
      sourceNativeIterableIntegrityOf(
        checker,
        flow,
        terminal.arguments[0]!,
        provider,
        (type) => (type.getSymbol() === symbol ? 'host::Collection' : null),
        new Set([terminal])
      )
    ).value !== null
  )
}

test('first-domain native receiver inventory requires closed property effects', () => {
  assert.equal(proof('const fresh={value:0};fresh.value=1'), true)
  assert.equal(proof(''), true)
  assert.equal(proof('const alias=input;const count=alias.length'), false)
  assert.equal(proof('', false), false)
})

for (const body of [
  'const alias:any=input;alias[Symbol.iterator]=()=>[][Symbol.iterator]()',
  'const alias:any=input;delete alias[Symbol.iterator]',
  'const narrowed=input as unknown as {other:number};narrowed.other=1',
  'Reflect.set(input,Symbol.iterator,()=>[][Symbol.iterator]())',
  'Reflect.defineProperty(input,Symbol.iterator,{value:()=>[][Symbol.iterator]()})',
  'Object.defineProperty(input,Symbol.iterator,{value:()=>[][Symbol.iterator]()})',
  'Object.setPrototypeOf(input,{})',
  'Object.assign(input,{[Symbol.iterator]:()=>[][Symbol.iterator]()})',
  'declare const unknownTarget:any;unknownTarget[Symbol.iterator]=()=>[][Symbol.iterator]()',
  'Object.getPrototypeOf(input)[Symbol.iterator]=()=>[][Symbol.iterator]()'
])
  test(`mutation route retains refusal: ${body}`, () => assert.equal(proof(body), false))

for (const body of [
  'declare function opaque(value:unknown):void;opaque(input)',
  'declare function opaque(value:unknown):void;opaque({nested:input})',
  'declare function opaque(value:unknown):void;opaque(()=>input)',
  'declare function opaque():void;opaque()'
])
  test(`opaque effects are not a readonly permission: ${body}`, () => assert.equal(proof(body), false))

for (const body of [
  'declare const foreign:{readonly value:number};const observed=foreign.value',
  'declare const foreign:{readonly [key:string]:number};const observed=foreign["value"]',
  'declare function opaque():number;const object={get value(){return opaque()}};const observed=object.value',
  'declare function opaque():void;function wrapper(){opaque()};wrapper()',
  'declare function opaque():void;const callback=()=>opaque();callback()'
])
  test(`implicit evaluation or source wrapper cannot hide opaque effects: ${body}`, () => assert.equal(proof(body), false))

test('closed source helper without property effects remains admitted', () => {
  assert.equal(proof('function identity(value:number){return value};const n=identity(1)'), true)
})
