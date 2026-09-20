import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'
import { coreHostMembers } from './host-members.js'
import { cppNativeProtocolsOf, handClaimedProtocols } from './native-protocols.js'

const fixture = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')

const compileSource = (source: string) =>
  compile({ rootFileNames: [fixture], projectFileName: null, sourceOverlay: new Map([[fixture, source]]) })

/**
 * The 48 protocols the pre-derivation `cppNativeProtocols` hand list stated,
 * frozen here as the equivalence baseline `cppNativeProtocolsOf` is measured
 * against -- not imported from `native-protocols.ts` (there is nothing left
 * to import: this list WAS that file, and the point of this test is to prove
 * the computed replacement still grants everything the hand-audited original
 * did, not to compare the derivation against itself).
 */
const preDerivationHandList: readonly string[] = [
  'Math@1',
  'Atomics@1',
  'DateConstructor@1',
  'Date.prototype@1',
  'String.prototype@1',
  'Number.prototype@1',
  'StringConstructor@1',
  'ErrorConstructor@1',
  'EvalErrorConstructor@1',
  'RangeErrorConstructor@1',
  'ReferenceErrorConstructor@1',
  'SyntaxErrorConstructor@1',
  'TypeErrorConstructor@1',
  'URIErrorConstructor@1',
  'NumberConstructor@1',
  'BigIntConstructor@1',
  'BooleanConstructor@1',
  'Boolean.prototype@1',
  'Int8ArrayConstructor@1',
  'Uint8ArrayConstructor@1',
  'Int16ArrayConstructor@1',
  'Uint16ArrayConstructor@1',
  'Int32ArrayConstructor@1',
  'Uint32ArrayConstructor@1',
  'Float32ArrayConstructor@1',
  'Float64ArrayConstructor@1',
  'Uint8ClampedArrayConstructor@1',
  'BigInt64ArrayConstructor@1',
  'BigUint64ArrayConstructor@1',
  'ArrayBufferConstructor@1',
  'SharedArrayBufferConstructor@1',
  'DataViewConstructor@1',
  'ArrayConstructor@1',
  'Console@1',
  'Uint8Array@1',
  'PromiseConstructor@1',
  'SymbolConstructor@1',
  'MapConstructor@1',
  'SetConstructor@1',
  'WeakMapConstructor@1',
  'WeakSetConstructor@1',
  'RegExpConstructor@1',
  'RegExp.prototype@1',
  'ObjectConstructor@1',
  'Object.prototype@1',
  'PropertyDescriptor@1',
  'Storage@1',
  'JSON@1'
]

/**
 * The only two protocols `cppNativeProtocolsOf` claims beyond the hand list --
 * `TextEncoder`/`TextDecoder`'s own native carrier strings, keyed by
 * `coreNativeTypes`'s spelling because `coreHostMembers` states real member
 * rows for both (`gea::runtime::textcodec::TextEncoder.encoding`, `.encode`,
 * ...). The hand list never claimed either name, and certification never
 * needed it to: `compiler.ts` separately unions `nativeTypes.values()` mapped
 * to `${carrier}@1` into the FINAL manifest, so a program holding a
 * `TextEncoder` already certified through that second route. The derivation
 * finds them anyway because it is honest about what `coreHostMembers` backs,
 * and re-deriving them here is harmless (`native-boundary` is a `.has()` gate)
 * rather than a regression -- see `core-globals.ts`'s own header comment,
 * which already claimed this exact table reaches the manifest's
 * `nativeProtocols` "with no second list to drift"; before this change that
 * was true only via the separate `nativeTypes.values()` route, and now it is
 * also true of this one.
 */
const extraBeyondHandList: readonly string[] = ['gea::runtime::textcodec::TextEncoder@1', 'gea::runtime::textcodec::TextDecoder@1']

test('cppNativeProtocolsOf reproduces the pre-derivation hand list exactly, plus the two documented extras', () => {
  const derived = [...cppNativeProtocolsOf(coreHostMembers)].sort()
  const expected = [...preDerivationHandList, ...extraBeyondHandList].sort()
  assert.deepEqual(derived, expected)
})

test('the residue is exactly the three protocols no table in src/targets/cpp backs', () => {
  assert.deepEqual([...handClaimedProtocols].sort(), ['BigInt64ArrayConstructor@1', 'BigUint64ArrayConstructor@1', 'Uint8Array@1'])
  // Every hand-claimed row must still be a member of the full derived set --
  // the residue is additive, never a silent narrowing of what the mechanical
  // sources already found.
  const derived = cppNativeProtocolsOf(coreHostMembers)
  for (const claim of handClaimedProtocols) assert.ok(derived.has(claim), `${claim} is missing from the derived set`)
})

test('a program exercising a spread of core protocols still certifies through the derived manifest', () => {
  const result = compileSource(`
    function run(value: unknown): string {
      const rounded = Math.floor(3.7) + Math.PI
      const stamp = Date.now()
      const map = new Map<string, number>()
      map.set('a', 1)
      const bytes = new Uint8Array(4)
      bytes[0] = rounded > 0 ? 1 : 0
      const payload = JSON.stringify({ rounded, stamp, size: bytes.length })
      const parsed = JSON.parse(payload) as { rounded: number }
      const resolved = Promise.resolve(parsed.rounded)
      void resolved
      try {
        throw new RangeError('boom')
      } catch (error) {
        if (error instanceof RangeError) return error.message
      }
      const described = Object.getOwnPropertyDescriptor({ a: 1 }, 'a')
      return String(value) + (described ? described.value : 0) + map.size
    }
    run(1)
  `)

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
})
