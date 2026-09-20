import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import {
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements,
  intrinsicProtocolRequirementKind,
  type IntrinsicProtocolRequirement
} from './deferred-intrinsic-protocols.js'
import { isArrayIndexKey, isCanonicalNumericKey, keySetTouches } from './host-mutation-keys.js'
import { createCensusComputedKeysOf, type CensusComputedKeys, type CensusComputedKeysOf } from './host-mutation-computed-keys.js'
import type { DeclarationId } from '../../identity/ids.js'

type Obligation = Omit<IntrinsicProtocolRequirement, 'location'>

/**
 * One whole-program census over a script (globals stay global), plus its
 * per-key obligations. Opaque receivers are unresolved call results: an
 * ambient `declare const` nothing writes is not one to this census.
 */
/**
 * The whole-program precondition the census requires before an unplaced value
 * may be read as possibly the global object: some expression has to have
 * produced the global object as a VALUE and let it reach a position the alias
 * graph does not follow. Every fixture below is about what an OPAQUE receiver
 * records, so each one has to state it -- a program that never mentions
 * `globalThis` proves the opposite, and then there is no opaque receiver left
 * to ask about.
 *
 * Stored into a field rather than passed to a callee: a call would also taint
 * whatever the callee could reach, and these tests name their taint exactly.
 */
const globalReachesData = 'const globalHolder: { escaped: unknown } = { escaped: null }; globalHolder.escaped = globalThis;'

const census = (
  source: string,
  computedKeysOf?: (flow: ReturnType<typeof indexValueFlow>, checker: ts.TypeChecker) => CensusComputedKeysOf
) => {
  const entry = resolve('test/fixtures/host-mutation-keys.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(
          name,
          `${source}
${globalReachesData}`,
          version,
          true
        )
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const identities = createIdentityTable(program, checker)
  const bindingId = (name: string): DeclarationId | null => {
    const symbol = checker.resolveName(name, file, ts.SymbolFlags.Value, false)
    return symbol ? identities.symbolValueDeclarationId(symbol, file) : null
  }
  const hostProcess = bindingId('hostProcess')
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const taint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(hostProcess === null ? [] : [hostProcess]),
    flow,
    wholeProgram,
    new Set(),
    new Set(),
    new Set(),
    undefined,
    program.getSourceFiles().filter((candidate) => candidate.isDeclarationFile),
    computedKeysOf?.(flow, checker)
  )
  const holds = (obligation: Obligation): boolean =>
    failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint: taint,
        isStandardLibraryDeclaration: (declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      },
      [{ ...obligation, location: file } as IntrinsicProtocolRequirement]
    ).length === 0
  return { taint, holds, hostProcess, file }
}

/** A fixture authority: the identifier `key` has exactly this answer. */
const keyAnswer =
  (answer: CensusComputedKeys | null): (() => CensusComputedKeysOf) =>
  () =>
  (expression) =>
    ts.isIdentifier(expression) && expression.text === 'key' ? answer : null

const lacks = (name: string): Obligation => ({ intrinsic: 'Object', prototypeKeys: { names: [name] } })

test('a numeric key is exactly a ToString(Number) spelling, and an array index is a canonical one below 2^32 - 1', () => {
  for (const key of ['0', '1.5', '-1', 'NaN', 'Infinity', '-Infinity', '1e+21']) assert.ok(isCanonicalNumericKey(key), key)
  for (const key of ['01', '-0', '1.50', '+1', ' 1', '0x10', 'glslVersion', '']) assert.ok(!isCanonicalNumericKey(key), key)
  for (const key of ['0', '7', '4294967294']) assert.ok(isArrayIndexKey(key), key)
  for (const key of ['4294967295', '-1', '1.5', 'NaN', '01']) assert.ok(!isArrayIndexKey(key), key)
})

test('a key set touches exactly the obligations naming one of its keys', () => {
  const numeric = { names: new Set<string>(), numeric: true, every: false }
  assert.ok(keySetTouches(numeric, { names: ['1.5'] }))
  assert.ok(keySetTouches(numeric, { arrayIndices: true }))
  assert.ok(!keySetTouches(numeric, { names: ['glslVersion', '@@iterator'] }))
  const named = { names: new Set(['needsUpdate', '3']), numeric: false, every: false }
  assert.ok(keySetTouches(named, { names: ['needsUpdate'] }))
  assert.ok(keySetTouches(named, { arrayIndices: true }))
  assert.ok(!keySetTouches({ names: new Set(['1.5']), numeric: false, every: false }, { arrayIndices: true }))
  assert.ok(!keySetTouches(named, { names: ['glslVersion'] }))
  assert.ok(keySetTouches(named, 'all'))
  assert.ok(keySetTouches({ names: new Set(), numeric: false, every: true }, { names: ['@@iterator'] }))
  assert.ok(!keySetTouches(undefined, 'all'))
})

test('numeric prototype obligations cover every Number spelling without claiming unrelated names', () => {
  for (const name of ['0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', '4294967295']) {
    const keys = { names: new Set([name]), numeric: false, every: false }
    assert.equal(keySetTouches(keys, { numeric: true }), true, name)
  }
  for (const name of ['label', '-0', '01', '1.50'])
    assert.equal(keySetTouches({ names: new Set([name]), numeric: false, every: false }, { numeric: true }), false, name)
  assert.equal(keySetTouches({ names: new Set(), numeric: true, every: false }, { numeric: true }), true)
  assert.equal(keySetTouches({ names: new Set(), numeric: false, every: true }, { numeric: true }), true)
  assert.equal(keySetTouches({ names: new Set(['Infinity']), numeric: false, every: false }, { arrayIndices: true }), false)
  const obligation: Obligation = { intrinsic: 'Object', prototypeKeys: { numeric: true } }
  assert.equal(census('(Object.prototype as any).label = 1').holds(obligation), true)
  assert.equal(census('(Object.prototype as any).Infinity = 1').holds(obligation), false)
  assert.equal(census('declare function mutate(value: unknown): void; class Item {} mutate(new Item())').holds(obligation), false)
})

test('an exact key through an opaque receiver is that key on every surface, never the wildcard', () => {
  const { taint, holds } = census('declare function opaque(): any; const o = opaque(); o.needsUpdate = true; o["value"] = 1')
  assert.equal(taint.has('*'), false)
  assert.deepEqual([...taint.surfaceKeys.names].sort(), ['needsUpdate', 'value'])
  assert.ok(holds(lacks('glslVersion')))
  assert.ok(!holds(lacks('needsUpdate')))
  assert.ok(!holds(lacks('value')))
  // The whole-prototype question still fails under any unattributed key.
  assert.ok(!holds({ intrinsic: 'Object' }))
  assert.ok(holds({ intrinsic: 'Array', prototypeKeys: { names: ['push', '@@iterator'], arrayIndices: true } }))
})

test('a number-typed key is the numeric domain, not an array index and not a name', () => {
  const numeric = census('declare function opaque(): any; const o = opaque(); declare const n: number; o[n] = 1')
  assert.equal(numeric.taint.has('*'), false)
  assert.equal(numeric.taint.surfaceKeys.numeric, true)
  assert.ok(numeric.holds(lacks('glslVersion')))
  for (const key of ['1.5', 'NaN', '-1', '0']) assert.ok(!numeric.holds(lacks(key)), key)
  assert.ok(!numeric.holds({ intrinsic: 'Array', prototypeKeys: { arrayIndices: true } }))
  const literal = census('declare function opaque(): any; const o = opaque(); o[1.50] = 1; o[0] = 1')
  assert.deepEqual([...literal.taint.surfaceKeys.names].sort(), ['0', '1.5'])
  assert.equal(literal.taint.surfaceKeys.numeric, false)
  assert.ok(!literal.holds({ intrinsic: 'Array', prototypeKeys: { arrayIndices: true } }))
  assert.ok(literal.holds({ intrinsic: 'Array', prototypeKeys: { names: ['push'] } }))
})

test('__proto__, globalThis, an unknown key and a string-literal-typed key stay the wildcard', () => {
  for (const write of [
    'o.__proto__ = null',
    'o["__proto__"] = null',
    'o.globalThis = 1',
    'declare const k: string; o[k] = 1',
    // A literal TYPE is not a proof: an `any` can carry "zzz" into it.
    "declare const k: 'a' | 'b'; o[k] = 1",
    'Object.defineProperty(o, Symbol.iterator, { value: 1 })'
  ]) {
    assert.ok(census(`declare function opaque(): any; const o = opaque(); ${write}`).taint.has('*'), write)
  }
})

test('a key a host or library accessor owns stays the wildcard unless its setter states the inert contract', () => {
  // lib.dom's `Node.textContent` setter runs host code no body states.
  assert.ok(census('declare function opaque(): any; const o = opaque(); o.textContent = "x"').taint.has('*'))
  assert.ok(
    census('declare class Widget { set mode(value: number) } declare function opaque(): any; const o = opaque(); o.mode = 1').taint.has('*')
  )
  const quiet = census(
    // Multi-line: TypeScript attaches no JSDoc to a member of a one-line class body.
    'declare class Quiet {\n  /** @gea-host-inert */\n  set level(value: number)\n}\ndeclare function opaque(): any; const o = opaque(); o.level = 1'
  ).taint
  assert.equal(quiet.has('*'), false)
  assert.ok(quiet.surfaceKeys.names.has('level'))
})

test('a bodiless host function is an unknown callee unless every declaration states the inert contract and nothing rebinds it', () => {
  assert.ok(census('declare function sink(value: unknown): void; sink(globalThis)').taint.has('*'))
  assert.equal(census('/** @gea-host-inert */ declare function sink(value: unknown): void; sink(globalThis)').taint.has('*'), false)
  // One uncovered overload is an unstated effect.
  assert.ok(
    census(
      '/** @gea-host-inert */ declare function sink(value: number): void; declare function sink(value: unknown): void; sink(globalThis)'
    ).taint.has('*')
  )
  // A rebound binding is no longer the declaration that stated the contract.
  assert.ok(
    census(
      '/** @gea-host-inert */ declare function sink(value: unknown): void; declare const other: typeof sink; // @ts-ignore\nsink = other; sink(globalThis)'
    ).taint.has('*')
  )
  assert.ok(census('declare const unknownCallee: any; unknownCallee(globalThis)').taint.has('*'))
})

// `sink`, never `external`: lib.dom declares `external` (window.external), and the
// checker resolves a script's `declare function external` to that standard-library
// symbol, whose intact identity the census trusts -- the call then never asks
// whether its argument holds the global object.
test('a source member call uses its closed invocation frame and a refused receiver stays opaque', () => {
  const closed = census(`
    class Receiver { run(value: unknown): void {} }
    new Receiver().run(globalThis);
  `)
  assert.equal(closed.taint.has('*'), false)

  const escaped = census(`
    declare function sink(value: unknown): void;
    class Receiver { run(value: unknown): void {} }
    const receiver = new Receiver();
    sink(receiver);
    receiver.run(globalThis);
  `)
  assert.equal(escaped.taint.has('*'), true)
})

test('source invocation layouts preserve default aliases only when the actual can be undefined', () => {
  const explicit = census(`
    declare function sink(value: unknown): void;
    class Receiver { run(value: unknown = globalThis): void { sink(value); } }
    new Receiver().run({});
  `)
  assert.equal(explicit.taint.has('*'), false)

  const omitted = census(`
    declare function sink(value: unknown): void;
    class Receiver { run(value: unknown = globalThis): void { sink(value); } }
    new Receiver().run();
  `)
  assert.equal(omitted.taint.has('*'), true)

  const undefinedArgument = census(`
    declare function sink(value: unknown): void;
    class Receiver { run(value: unknown = globalThis): void { sink(value); } }
    new Receiver().run(undefined);
  `)
  assert.equal(undefinedArgument.taint.has('*'), true)
})

test('a direct sloppy source call maps implicit this to the global object', () => {
  const result = census(`
    declare const key: string;
    function patch() { this[key] = 1; }
    patch();
  `)
  assert.equal(result.taint.has('*'), true)
})

test('a keyed write through an opaque receiver withdraws trust in the intrinsic member of that name', () => {
  const setup = 'interface Process {} declare var hostProcess: Process;'
  const trusted = census(`${setup} ;(String.fromCharCode(65) as any).hostProcess = undefined`)
  assert.deepEqual([...trusted.taint], [])
  // The opaque write may have replaced String.fromCharCode with a function
  // returning the global object; its result is then no longer a string.
  const patched = census(
    `${setup} declare function opaque(): any; const o = opaque(); o.fromCharCode = () => globalThis; ;(String.fromCharCode(65) as any).hostProcess = undefined`
  )
  assert.equal(patched.taint.has('*'), false)
  assert.ok(patched.hostProcess !== null && patched.taint.has(patched.hostProcess))
})

test('the ledger keeps a per-key prototype obligation distinct from the whole prototype and from other key sets', () => {
  const ledger = createDeferredIntrinsicProtocolLedger()
  const location = ts.createSourceFile('input.ts', '', ts.ScriptTarget.ES2022, true)
  assert.equal(ledger.requirePrototypeKeys('Object', { names: ['a'] }, location), false)
  const attempt = ledger.capture(() => {
    ledger.requirePrototypeKeys('Object', { names: ['a'] }, location)
    ledger.requirePrototypeKeys('Object', { names: ['a', 'a'] }, location)
    ledger.requirePrototypeKeys('Object', { names: ['b'] }, location)
    ledger.requirePrototypeKeys('Array', { names: ['push'], arrayIndices: true }, location)
    ledger.requirePrototypeKeys('Object', { numeric: true }, location)
    ledger.require('Object', location)
  })
  assert.deepEqual(attempt.requirements.map(intrinsicProtocolRequirementKind), [
    'keys:a',
    'keys:b',
    'keys:push|indices',
    'keys:|numeric',
    undefined
  ])
})

const forIn = (receiver: string, prefix = '') => `${prefix}
  const values = { a: 1, b: 2 }
  ${receiver}
  for (const key in values) target[key] = 1`
const forInKeys: CensusComputedKeys = { keys: new Set(['a', 'b']), inheritsObjectPrototypeKeys: true, requirements: [] }

test('a for-in key set feeding a write whose receiver may be Object.prototype writes exactly those keys there', () => {
  // The receiver side is proven independently: an opaque receiver may be
  // Object.prototype, so the keys land on every surface and the absence of
  // `a` on Object.prototype refuses.
  const opaque = census(forIn('declare function opaqueTarget(): any; const target = opaqueTarget()'), keyAnswer(forInKeys))
  assert.equal(opaque.taint.has('*'), false)
  assert.deepEqual([...opaque.taint.surfaceKeys.names].sort(), ['a', 'b'])
  assert.ok(!opaque.holds(lacks('a')))
  assert.ok(!opaque.holds(lacks('b')))
  assert.ok(opaque.holds(lacks('glslVersion')))
  const prototype = census(forIn('const target: any = Object.prototype'), keyAnswer(forInKeys))
  assert.ok(!prototype.holds(lacks('a')))
  assert.ok(prototype.holds(lacks('glslVersion')))
  // Without an authority the key is unknown.
  assert.ok(census(forIn('declare function opaqueTarget(): any; const target = opaqueTarget()')).taint.has('*'))
  assert.ok(census(forIn('declare function opaqueTarget(): any; const target = opaqueTarget()'), keyAnswer(null)).taint.has('*'))
})

test('a for-in key set holds every key the program may have put on Object.prototype', () => {
  const extra = forIn('declare function opaqueTarget(): any; const target = opaqueTarget()', '(Object.prototype as any).extra = 1')
  const inherited = census(extra, keyAnswer(forInKeys))
  assert.equal(inherited.taint.has('*'), false)
  // `for-in` walks the inherited `extra` too, so the write may put it on any surface.
  assert.deepEqual([...inherited.taint.surfaceKeys.names].sort(), ['a', 'b', 'extra'])
  // Own keys only (`Object.keys`): nothing inherited is added.
  const own = census(extra, keyAnswer({ ...forInKeys, inheritsObjectPrototypeKeys: false }))
  assert.deepEqual([...own.taint.surfaceKeys.names].sort(), ['a', 'b'])
  // An unknown key on a surface is every key: the set is refused.
  assert.ok(
    census(
      forIn(
        'declare function opaqueTarget(): any; const target = opaqueTarget()',
        'declare function opaque(): any; const o = opaque(); declare const k: string; o[k] = 1'
      ),
      keyAnswer(forInKeys)
    ).taint.has('*')
  )
})

test('a key set whose intrinsic assumption the census itself disproves is refused', () => {
  const assumesKeys = (file: ts.SourceFile): CensusComputedKeys => ({
    keys: new Set(['a']),
    inheritsObjectPrototypeKeys: false,
    requirements: [{ intrinsic: 'Object', member: 'keys', location: file }]
  })
  const answer = (): CensusComputedKeysOf => (expression) =>
    ts.isIdentifier(expression) && expression.text === 'key' ? assumesKeys(expression.getSourceFile()) : null
  const intact = census(forIn('declare function opaqueTarget(): any; const target = opaqueTarget()'), answer)
  assert.equal(intact.taint.has('*'), false)
  assert.deepEqual([...intact.taint.surfaceKeys.names], ['a'])
  const replaced = census(
    forIn('declare function opaqueTarget(): any; const target = opaqueTarget()', 'Object.keys = (() => ["zzz"]) as any'),
    answer
  )
  assert.ok(replaced.taint.has('*'))
})

test('the census authority proves a for-in key set over a closed literal', () => {
  const source = `
    declare function opaqueTarget(): any; const target = opaqueTarget()
    const values = { a: 1, b: 2 }
    for (const key in values) target[key] = 1`
  const { taint } = census(source, (flow, checker) =>
    createCensusComputedKeysOf(
      checker,
      flow,
      closedCallableAuthorityOf(
        checker,
        flow,
        (value) => checker.getTypeAtLocation(value),
        () => undefined
      )
    )
  )
  assert.equal(taint.has('*'), false)
  assert.deepEqual([...taint.surfaceKeys.names].sort(), ['a', 'b'])
})
