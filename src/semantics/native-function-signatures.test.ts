import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusNativeFunctionSignatures } from './native-function-signatures.js'
import { createIdentityTable } from './normalize/identities.js'
import type { NativeHostFunctionDeclaration } from '../plugins/model.js'
import { compile } from '../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from '../plugins/model.js'

const declarationFileName = resolve('test/native-function-signatures.d.ts')
const entry = resolve('test/native-function-signatures.ts')
const sources = new Map([
  ['integerHost', 'integerAlias'],
  ['fractionalHost', 'fractionalAlias'],
  ['mixedHost', 'mixedCallback'],
  ['wideHost', 'wideCallback']
])
const declarations: NativeHostFunctionDeclaration[] = [...sources].map(([declarationName, cppName]) => ({
  declarationFileName,
  declarationName,
  inspection: { cppFunction: `gea::signature_test::${cppName}`, headers: [resolve('test/native-signatures.h')] }
}))

const census = (source: string, declarationOverlay?: string) => {
  const host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2022 })
  const read = host.readFile.bind(host)
  host.readFile = (file) =>
    resolve(file) === entry
      ? source
      : declarationOverlay !== undefined && resolve(file) === declarationFileName
        ? declarationOverlay
        : read(file)
  const program = ts.createProgram([entry, declarationFileName], { target: ts.ScriptTarget.ES2022 }, host)
  const checker = program.getTypeChecker()
  return censusNativeFunctionSignatures(checker, program.getSourceFiles(), createIdentityTable(program, checker), declarations)
}

test('native header facts authenticate the exact host declaration and callback position', () => {
  const result = census('integerHost(value => console.log(value)); mixedHost((i, f) => console.log(i, f))')
  assert.equal(result.signatures.size, 2)
  const facts = [...result.callbackParameters.values()]
  assert.deepEqual(facts[0]?.get(0), [{ kind: 'bounded', limit: 2147483648 }])
  assert.deepEqual(facts[1]?.get(0), [{ kind: 'bounded', limit: 2147483648 }, null])
  assert.match(result.assertions[0] ?? '', /numeric_limits<int>::digits == 31/)
})

test('floating and inexact wide native callback values do not gain integer facts', () => {
  const result = census('fractionalHost(value => console.log(value)); wideHost(value => console.log(value))')
  for (const facts of result.callbackParameters.values()) assert.deepEqual(facts.get(0), [null])
  assert.deepEqual(result.assertions, [])
})

test('application shadowing and unauthorized declaration merging cannot inherit host integer facts', () => {
  for (const source of [
    'function local() { const integerHost = (callback: (value: number) => void) => callback(0.5); integerHost(value => console.log(value)); } local();',
    'declare function integerHost(callback: (value: number) => void): number; integerHost(value => console.log(value));'
  ])
    assert.equal(census(source).callbackParameters.size, 0)
})

test('callback arity and scalar type mismatches fail before facts are published', () => {
  for (const declaration of [
    'declare function integerHost(callback: () => void): number',
    'declare function integerHost(callback: (value: string) => void): number',
    'declare function integerHost(callback: (value: number) => boolean): number'
  ])
    assert.throws(() => census('integerHost(value => console.log(value))', declaration), /Native callback/)
})

test('declared integer callback parameters accept fitting native integers and reject floating or oversized inputs', () => {
  const types =
    'declare const brand: unique symbol; type int = number & { readonly [brand]?: never }; type i32 = number & { readonly [brand]?: never };'
  for (const type of ['int', 'i32']) {
    const result = census(
      'integerHost(value => console.log(value))',
      `${types} declare function integerHost(callback: (value: ${type}) => void): number;`
    )
    assert.deepEqual([...result.callbackParameters.values()][0]?.get(0), [{ kind: 'bounded', limit: 2147483648 }])
  }
  assert.throws(
    () =>
      census(
        'fractionalHost(value => console.log(value))',
        `${types} declare function fractionalHost(callback: (value: int) => void): void;`
      ),
    /Native callback parameter mismatch/
  )
  assert.throws(
    () => census('wideHost(value => console.log(value))', `${types} declare function wideHost(callback: (value: i32) => void): void;`),
    /Native callback parameter mismatch/
  )
})

test('generated callback and downstream tick use the proven integer without a second tick body', () => {
  const plugin: CompilerPlugin = {
    name: 'native-signature-fixture',
    instantiate: () => ({
      producers: () => [],
      lower: () => false,
      capabilities: {
        ...noPluginCapabilities,
        nativeFunctionDeclarations: [declarations[0]!],
        hostFunctions: new Map([['integerHost', 'gea::signature_test::integerAlias']]),
        hostPreambles: new Map([['gea::signature_test::integerAlias', [`#include "${resolve('test/native-signatures.h')}"`]]])
      }
    })
  }
  const source = `function tick(value: number) {
    let result = value % 1000;
    result = (result + 1) % 1000; result = (result + 2) % 1000;
    result = (result + 3) % 1000; result = (result + 4) % 1000;
    result = (result + 5) % 1000; result = (result + 6) % 1000;
    result = (result + 7) % 1000; result = (result + 8) % 1000;
    console.log(result);
  }
  integerHost(value => tick(value));`
  const result = compile({ rootFileNames: [entry, declarationFileName], plugins: [plugin], sourceOverlay: new Map([[entry, source]]) })
  assert.equal(result.diagnostics.planClean, true, JSON.stringify(result.diagnostics))
  assert.ok(result.source)
  const code = result.source
  assert.doesNotMatch(code, /_integral/)
  assert.match(code, /long long/)
  assert.match(code, /Native callback integer type differs/)
  assert.match(
    code,
    /std::is_same_v<decltype\(&gea::signature_test::integerAlias\), std::add_pointer_t<int\(std::function<void\(int\)>\)>>/
  )
})
