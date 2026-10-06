import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectNativeFunctionSignature } from './native-signatures.js'
import type { NativeFunctionInspection, NativeSignatureType } from './native-signatures.js'

const fixture: Omit<NativeFunctionInspection, 'cppFunction'> = {
  headers: ['native-signatures.h'],
  includeDirectories: [fileURLToPath(new URL('../test', import.meta.url))]
}

function callback(functionName: string, compilerArguments?: readonly string[]) {
  const signature = inspectNativeFunctionSignature({
    ...fixture,
    cppFunction: `gea::signature_test::${functionName}`,
    ...(compilerArguments ? { compilerArguments } : {}),
    expectedParameterCount: 1
  })
  const parameter = signature.parameters[0]!
  assert.equal(parameter.kind, 'callback')
  if (parameter.kind !== 'callback') throw new Error('Expected native callback')
  return parameter
}

function integer(type: NativeSignatureType) {
  assert.equal(type.kind, 'integer')
  if (type.kind !== 'integer') throw new Error('Expected native integer')
  return type
}

test('actual host RAF aliases authenticate a bounded integer callback', () => {
  const signature = inspectNativeFunctionSignature({
    cppFunction: 'gea::host::requestAnimationFrame',
    headers: ['host/timers.h'],
    includeDirectories: [fileURLToPath(new URL('../../core/packages/host/include', import.meta.url))],
    expectedParameterCount: 1,
    expectedCallbacks: [{ parameter: 0, arguments: 1 }]
  })
  assert.equal(signature.result.kind, 'floating')
  const callback = signature.parameters[0]!
  assert.equal(callback.kind, 'callback')
  if (callback.kind !== 'callback') throw new Error('Expected RAF callback')
  assert.deepEqual(integer(callback.parameters[0]!), {
    kind: 'integer',
    cppType: 'int',
    bits: 32,
    signed: true,
    minimum: '-2147483648',
    maximum: '2147483647',
    exactlyRepresentableAsNumber: true
  })
  assert.match(signature.evidence.astSha256, /^[a-f0-9]{64}$/)
})

test('nested typedefs resolve without inferring integer facts from function names', () => {
  const type = integer(callback('integerAlias').parameters[0]!)
  assert.equal(type.cppType, 'int')
  assert.equal(type.bits, 32)
  assert.equal(callback('fractionalAlias').parameters[0]!.kind, 'floating')
})

test('callback argument positions preserve distinct integer and floating types', () => {
  for (const name of ['mixedCallback', 'pointerCallback']) {
    const signature = callback(name)
    assert.equal(signature.parameters.length, 2)
    assert.equal(signature.parameters[0]!.kind, 'integer')
    assert.equal(signature.parameters[1]!.kind, 'floating')
  }
})

test('wide integers carry bounds and cannot authenticate exact JS number inputs', () => {
  const type = integer(callback('wideCallback').parameters[0]!)
  assert.equal(type.bits, 64)
  assert.equal(type.minimum, '-9223372036854775808')
  assert.equal(type.maximum, '9223372036854775807')
  assert.equal(type.exactlyRepresentableAsNumber, false)
})

test('Clang configuration changes signedness and remains in inspection evidence', () => {
  const signed = integer(callback('characterCallback', ['-fsigned-char']).parameters[0]!)
  const unsigned = integer(callback('characterCallback', ['-funsigned-char']).parameters[0]!)
  assert.equal(signed.signed, true)
  assert.equal(unsigned.signed, false)
  assert.equal(unsigned.minimum, '0')
  assert.equal(unsigned.maximum, '255')
})

test('ambiguous overloads and unavailable declarations fail closed', () => {
  for (const name of ['overloaded', 'absent']) {
    assert.throws(
      () => inspectNativeFunctionSignature({ ...fixture, cppFunction: `gea::signature_test::${name}` }),
      /Clang native signature inspection failed/
    )
  }
})

test('native binding and callback arity mismatches fail closed', () => {
  assert.throws(
    () => inspectNativeFunctionSignature({ ...fixture, cppFunction: 'gea::signature_test::mixedCallback', expectedParameterCount: 2 }),
    /Native function parameter count/
  )
  assert.throws(
    () =>
      inspectNativeFunctionSignature({
        ...fixture,
        cppFunction: 'gea::signature_test::mixedCallback',
        expectedCallbacks: [{ parameter: 0, arguments: 1 }]
      }),
    /Native callback parameter count/
  )
})

test('unknown integer widths never become safe native integer facts and variadics fail closed', () => {
  assert.equal(callback('unsupportedCallback').parameters[0]!.kind, 'unsupported')
  assert.throws(() => callback('variadicCallback'), /variadic signature/)
})

test('native pointers and references never masquerade as scalar integer callback facts', () => {
  for (const name of ['dataPointerCallback', 'referenceCallback']) {
    assert.equal(callback(name).parameters[0]!.kind, 'unsupported')
  }
})

test('callable object pointers and indirect function pointers are not callback values', () => {
  for (const name of ['objectPointerCallback', 'indirectPointerCallback']) {
    const signature = inspectNativeFunctionSignature({ ...fixture, cppFunction: `gea::signature_test::${name}` })
    assert.equal(signature.parameters[0]!.kind, 'unsupported')
  }
  assert.equal(callback('referenceFunctionCallback').parameters[0]!.kind, 'integer')
})

test('canonical function types resolve aliases and retain semantic exception specifications', () => {
  const signature = inspectNativeFunctionSignature({ ...fixture, cppFunction: 'gea::signature_test::integerAlias' })
  assert.equal(signature.canonicalFunctionType, 'std::add_pointer_t<int(std::function<void(int)>)>')
  const noexcept = inspectNativeFunctionSignature({ ...fixture, cppFunction: 'gea::signature_test::noexceptCallback' })
  assert.equal(noexcept.canonicalFunctionType, 'std::add_pointer_t<void(std::function<void(int)>) noexcept>')
})

test('target compilation rejects a macro-selected fractional callback despite unchanged integer width', () => {
  const signature = inspectNativeFunctionSignature({ ...fixture, cppFunction: 'gea::signature_test::configuredCallback' })
  assert.ok(signature.canonicalFunctionType)
  const probe = `#include "native-signatures.h"
#include <type_traits>
#include <limits>
static_assert(std::numeric_limits<int>::digits == 31);
static_assert(std::is_same_v<decltype(&gea::signature_test::configuredCallback), ${signature.canonicalFunctionType}>, "Native signature changed");`
  const compile = (arguments_: readonly string[]) =>
    spawnSync(
      'clang++',
      [
        '-std=c++17',
        ...fixture.includeDirectories!.flatMap((directory) => ['-I', directory]),
        ...arguments_,
        '-x',
        'c++',
        '-fsyntax-only',
        '-'
      ],
      { input: probe, encoding: 'utf8', timeout: 60_000 }
    )
  const unchanged = compile([])
  assert.equal(unchanged.status, 0, unchanged.stderr)
  const changed = compile(['-DGEA_SIGNATURE_FRACTIONAL_CALLBACK'])
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /Native signature changed/)
})
