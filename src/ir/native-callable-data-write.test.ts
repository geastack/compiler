import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import { nativeCallableDataWriteMatches, nativeCallableDataWritesOf } from './native-callable-data-write.js'
import { nativeCallableDataSlotInputOf, nativeCallableDataSlotMatches } from './native-callable-data-slots.js'
import { nativeCallablePrototypeMatches } from './native-callable-prototype.js'
import type { IrValueId } from '../identity/ids.js'
import { nativeCallablePrimitiveDataWritePreservesOwner } from './native-callable-data-flow.js'
import { nativeCallableTypedDataReadRequiresAuthority } from './native-callable-data-reads.js'
import { callableSidecarGetText } from '../targets/cpp/emit-dynamic-properties.js'
import type { EmitContext } from '../targets/cpp/emit-context.js'
import { dynamicReasons, type Representation } from '../representation/model.js'

const entry = resolve('test/runtime/function-value-computed-symbol.ts')
const compileSource = (source: string): CompilationResult =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })
const operationsOf = (result: CompilationResult): IrOperation[] =>
  (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))

test('native Function descriptor writes retain typed scalar payloads under source-proven inherited absence', () => {
  const result = compileSource(`export {}
    function fn() { return 1 }
    ;(fn as unknown as { label?: string | number }).label = 'native'
    ;(fn as unknown as { label?: string | number }).label = 17
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const writes = operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
  assert.equal(writes.length, 2)
  assert.match(result.source!, /gea::callableNativeDataSetWithReceiver/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
  for (const operation of writes) {
    assert.equal(operation.kind, 'set')
    if (operation.kind !== 'set') continue
    const proof = operation.nativeCallableDataWrite!
    assert.equal(nativeCallableDataWriteMatches(proof, proof), true)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, value: proof.receiver }), false)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, key: proof.value }), false)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, materialization: 'unrelated-boundary' as never }), false)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, storageConversion: 'unrelated-storage-fit' as never }), false)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, storedValue: proof.receiver }), false)
    assert.equal(proof.materialization, null, 'native-only writes do not require a dynamic payload callback')
    assert.equal(proof.receiverMaterialization, null, 'the sealed data-only receiver cannot call a dynamic setter')
    assert.equal(proof.storage.kind, 'tagged-union')
    assert.equal(proof.storageFits.length, 2)
    assert.equal(nativeCallableDataWriteMatches(proof, { ...proof, prototypeProtocol: 'own-facts' }), false)
  }
})

test('a later retained subclass initializer cannot publish an earlier fresh arrow field', () => {
  for (const published of [false, true]) {
    const result = compileSource(`export {}
      declare function publish(value: unknown): void
      class Owner { callback = () => 'native' }
      const instance = new Owner()
      ${published ? 'publish(instance)' : ''}
      ;(instance.callback as unknown as { tag?: string }).tag = 'held'
      console.log((instance.callback as unknown as { tag?: string }).tag)
      class Later extends Owner { extra = 1 }
      const later = new Later()
      console.log(later.callback())
    `)
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    const writes = operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
    assert.equal(writes.length, published ? 0 : 1)
    if (published) assert.equal(result.certificate, null)
    else {
      assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
      assert.ok(operationsOf(result).some((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead))
      assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
    }
  }
})

test('a primitive Function data write preserves existing field identity and cannot lend a stale storage or boxed read route', () => {
  const result = compileSource(`export {}
    class Owner { callback = (text: string): string => text }
    const owner = new Owner()
    ;(owner.callback as unknown as { tag?: string }).tag = 'native'
    console.log((owner.callback as unknown as { tag?: string }).tag)
  `)
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  const operations = operationsOf(result)
  const definitions = new Map(
    operations.flatMap((operation) => ('result' in operation && operation.result ? [[operation.result.id, operation] as const] : []))
  )
  const write = operations.find((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
  assert.ok(write?.kind === 'set')
  if (write?.kind !== 'set') return
  const conversionNodes = result.conversionCensus
  const preserves = (operation: typeof write) =>
    nativeCallablePrimitiveDataWritePreservesOwner(operation, conversionNodes, (id) => definitions.get(id))
  const receipt = write.nativeCallableDataWrite!
  assert.equal(preserves(write), true)
  const { nativeCallableDataWrite: _receipt, ...unselected } = write
  assert.equal(preserves(unselected), false)
  assert.equal(preserves({ ...write, nativeCallableDataWrite: { ...receipt, receiver: receipt.value } }), false)
  assert.equal(preserves({ ...write, nativeCallableDataWrite: { ...receipt, storedValue: receipt.receiver } }), false)
  assert.equal(preserves({ ...write, nativeCallableDataWrite: { ...receipt, storageConversion: 'unrelated-fit' as never } }), false)
  assert.equal(preserves({ ...write, nativeCallableDataWrite: { ...receipt, storageFits: [] } }), false)
  const read = operations.find((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead)
  assert.ok(read?.kind === 'get')
  if (read?.kind !== 'get') return
  assert.equal(nativeCallableTypedDataReadRequiresAuthority(read, 'tag'), true)
  for (const reason of dynamicReasons) {
    const observation: Representation = { kind: 'dynamic', reason }
    for (const representation of [observation, { kind: 'optional' as const, payload: observation, absence: 'undefined' as const }])
      assert.equal(
        nativeCallableTypedDataReadRequiresAuthority({ ...read, result: { ...read.result, representation } }, 'tag'),
        reason !== 'declared-any-never-narrowed',
        `${reason} cannot substitute for this property's declared any/unknown observation`
      )
  }
  assert.equal(nativeCallableDataSlotMatches(read.nativeCallableDataSlot, undefined), false)
  const { nativeCallableDataSlot: _slot, ...broken } = read
  assert.throws(
    () => callableSidecarGetText({ staticKeyTexts: new Map([[read.key.value, 'tag']]) } as unknown as EmitContext, broken),
    /no selected native storage receipt/
  )
  assert.ok(
    result.source!.includes('gea_data_identity->properties->ownProperty(gea_data_key)'),
    'the native read checks actual own presence'
  )
  assert.ok(
    result.source!.includes('gea_data_identity->properties->readNativeData<std::string>(gea_data_key)'),
    'the exact held string is read directly from the native descriptor holder'
  )
  assert.ok(result.source!.includes('return gea_sum_widen(gea::Undefined{})'), 'absence executes the selected Undefined child')
  assert.ok(result.source!.includes('return gea::Optional<std::string>{*gea_data_value}'), 'presence executes the selected native child')
  assert.doesNotMatch(result.source!, /a static callable expando read/)
})

test('native direct callback transfers retain their actual callee identities and independently replay the complete body frame', () => {
  const result = compileSource(`export {}
    class Owner { callback = (value: string): string => value }
    function consume(callback: (value: string) => string, value: string): string { return callback(value) }
    function foreign(value: string): string { return 'foreign:' + value }
    const first = new Owner()
    console.log(consume(first.callback, 'native'))
    console.log(foreign('separate'))
    const instance = new Owner()
    ;(instance.callback as unknown as { tag?: string }).tag = 'held'
    console.log((instance.callback as unknown as { tag?: string }).tag)
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  const bodies = new Map((result.irBodies ?? []).map((body) => [body.owner, body]))
  const target = operationsOf(result).find((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
  assert.ok(target && target.kind === 'set')
  const transfer = operationsOf(result).find(
    (operation) =>
      operation.kind === 'call' &&
      operation.arguments.length === 2 &&
      operation.arguments[0]?.representation.kind === 'function-value-dispatch'
  )
  assert.ok(transfer && transfer.kind === 'call')
  const definition = operationsOf(result).find(
    (operation) => operation.kind === 'binding-read' && operation.result.id === transfer.callee.value
  )
  assert.ok(definition && definition.kind === 'binding-read')
  const callable = result.projection.callableOrigins.get(definition.lineage!)
  assert.ok(callable)
  const implementation = [...bodies.values()].find((body) => body.sourceOwner === callable)
  assert.ok(implementation?.abi)
  const foreignCall = operationsOf(result).find((operation) => {
    if (operation.kind !== 'call' || operation.arguments.length !== 1 || operation.result?.representation.kind !== 'string') return false
    const producer = operationsOf(result).find(
      (candidate) => candidate.kind === 'binding-read' && candidate.result.id === operation.callee.value
    )
    return producer?.lineage !== null && producer?.lineage !== undefined && result.projection.callableOrigins.has(producer.lineage)
  })
  assert.ok(foreignCall && foreignCall.kind === 'call')
  const receipts = (actual: ReadonlyMap<IrBody['owner'], IrBody>) =>
    nativeCallableDataWritesOf(
      nativeCallableDataSlotInputOf({
        bodies: actual,
        graph: result.graph,
        placements: result.projection.placements,
        classes: result.projection.classes,
        deriver: result.representations.deriver,
        conversions: result.conversionCensus,
        nativeCallableData: result.representations.nativeCallableData,
        programConversions: null
      })
    )
  assert.ok(receipts(bodies).has(target))
  const rewriteTransfer = (replacement: IrOperation): ReadonlyMap<IrBody['owner'], IrBody> =>
    new Map(
      [...bodies].map(([id, body]) => [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((operation) => (operation === transfer ? (replacement as typeof operation) : operation))
              }
            ])
          )
        }
      ])
    )
  assert.equal(
    receipts(rewriteTransfer({ ...transfer, callee: { ...transfer.callee, value: 'unknown-source' as never } })).has(target),
    false
  )
  assert.equal(receipts(rewriteTransfer({ ...transfer, arguments: [transfer.arguments[1]!, transfer.arguments[1]!] })).has(target), false)
  assert.equal(receipts(rewriteTransfer({ ...transfer, arguments: [foreignCall.callee, transfer.arguments[1]!] })).has(target), false)
  const mismatched = new Map(bodies)
  mismatched.set(implementation.owner, {
    ...implementation,
    abi: { ...implementation.abi, result: { kind: 'scalar', domain: 'number' } }
  })
  assert.equal(receipts(mismatched).has(target), false)
})

test('heterogeneous native Function data writers retain one held union and actual missing-property observations', () => {
  const result = compileSource(`export {}
    const target: (() => number) & { payload?: null | number[] } = () => 0
    function snapshot() { return target.payload }
    target.payload = null
    console.log(snapshot() === null)
    target.payload = [4, 7]
    const payload = snapshot()
    if (payload) console.log(payload.join(','))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const writes = operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
  assert.equal(writes.length, 2)
  const reads = operationsOf(result).filter((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead)
  assert.ok(reads.length > 0)
  for (const operation of writes) {
    if (operation.kind !== 'set') continue
    const receipt = operation.nativeCallableDataWrite!
    assert.equal(receipt.storage.kind, 'tagged-union')
    assert.equal(receipt.storageFits.length, 2)
    assert.equal(receipt.materialization, null)
    assert.equal(nativeCallableDataWriteMatches(receipt, { ...receipt, storageFits: receipt.storageFits.slice(0, 1) }), false)
  }
  for (const operation of reads) {
    if (operation.kind !== 'get') continue
    const receipt = operation.nativeCallableDataSlot!
    assert.equal(receipt.optionalRead!.installations.length, 2)
    assert.equal(
      nativeCallableDataSlotMatches(receipt, {
        ...receipt,
        optionalRead: { ...receipt.optionalRead!, installations: receipt.optionalRead!.installations.slice(0, 1) }
      }),
      false
    )
  }
  assert.doesNotMatch(result.source!, /gea::callableDynamic(?:Set|Get)/)
})

test('an ordinary callable constructor retains native sidecar values across direct and Reflect deletion', () => {
  const result = compileSource(`export {}
    type Owner = { (): number; new (): { value: number }; slot?: number }
    const owner = function () { return 1 } as unknown as Owner
    owner.slot = 7
    const first = (owner as Owner & { slot: number }).slot
    console.log(first)
    delete owner.slot
    const absent = owner.slot
    Reflect.set(owner, 'slot', 8)
    const present = owner.slot
    Reflect.deleteProperty(owner, 'slot')
    console.log(absent === undefined, present, owner.slot === undefined)
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const reads = operationsOf(result).filter((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot)
  assert.ok(reads.some((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.presentRead))
  assert.ok(reads.some((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead))
  for (const operation of reads) {
    if (operation.kind !== 'get') continue
    const proof = operation.nativeCallableDataSlot!
    assert.equal(nativeCallableDataSlotMatches(proof, proof), true)
    assert.equal(nativeCallableDataSlotMatches(proof, { ...proof, ownerAllocation: operation.key.value }), false)
    if (proof.presentRead) {
      assert.equal(nativeCallableDataSlotMatches(proof, { ...proof, value: operation.receiver }), false)
      assert.equal(
        nativeCallableDataSlotMatches(proof, { ...proof, presentRead: { ...proof.presentRead, conversion: 'unrelated-read' as never } }),
        false
      )
    }
  }
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
})

test('deletion, descriptor replacement and an opaque consumer cannot borrow a required native data read', () => {
  for (const change of [
    'delete owner.slot',
    "Reflect.deleteProperty(owner, 'slot')",
    "Object.defineProperty(owner, 'slot', { value: 9, writable: false })",
    'expose(owner)'
  ]) {
    const result = compileSource(`export {}
      declare function expose(value: unknown): void
      const owner = () => 1
      ;(owner as unknown as { slot?: number }).slot = 7
      ${change.replaceAll('owner.slot', '(owner as unknown as { slot?: number }).slot')}
      console.log((owner as unknown as { slot: number }).slot)
    `)
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.ok(!operationsOf(result).some((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.presentRead), change)
    assert.equal(result.certificate, null, change)
  }
})

test('an inherited setter or changed owner chain cannot borrow native own-descriptor storage', () => {
  for (const mutation of [
    `Object.defineProperty(Function.prototype, 'label', { set(value: unknown) { console.log(value) }, configurable: true })`,
    `;(target as any).__proto__ = { set label(value: unknown) { console.log(value) } }`
  ]) {
    const result = compileSource(`export {}
      function target() { return 1 }
      ${mutation}
      ;(target as unknown as { label?: number }).label = 42
    `)
    assert.equal(
      operationsOf(result).some(
        (operation) => (operation.kind === 'set' || operation.kind === 'call') && operation.nativeCallableDataWrite
      ),
      false
    )
    assert.equal(result.certificate, null)
  }
})

test('a program Symbol writer uses its source origin witness rather than a Symbol index signature', () => {
  const result = compileSource(`export {}
    function target() { return 1 }
    const key = Symbol.for('native-function-write')
    ;(target as unknown as Record<symbol, unknown>)[key] = 42
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  assert.equal(operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite).length, 1)
  assert.match(result.source!, /gea::callableNativeDataSetWithReceiver/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
})

test('an erased well-known Symbol assertion cannot borrow ordinary string or program Symbol absence', () => {
  const result = compileSource(`export {}
    function target() { return 1 }
    const declaredKey = Symbol.for('native-function-write')
    const key = Symbol.hasInstance as typeof declaredKey
    ;(target as unknown as Record<symbol, unknown>)[key] = 42
  `)
  assert.equal(
    operationsOf(result).some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite),
    false
  )
  assert.equal(result.certificate, null)
})

test('an immutable alias of the written program Symbol keeps its native Function owner', () => {
  const result = compileSource(`export {}
    function target() { return 1 }
    const key = Symbol.for('native-function-read')
    const alias = key
    ;(target as unknown as Record<symbol, unknown>)[key] = 42
    console.log((target as unknown as Record<symbol, unknown>)[alias])
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  assert.equal(operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite).length, 1)
  assert.match(result.source!, /gea::callableNativeDataSetWithReceiver/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
})

test('a different or mutable Symbol cannot borrow a native owner observation', () => {
  for (const declaration of [`const other = Symbol.for('different-native-function-read')`, `let other = key; other = Symbol.hasInstance`]) {
    const result = compileSource(`export {}
      function target() { return 1 }
      const key = Symbol.for('native-function-read')
      ${declaration}
      ;(target as unknown as Record<symbol, unknown>)[key] = 42
      console.log((target as unknown as Record<symbol, unknown>)[other])
    `)
    assert.equal(
      operationsOf(result).some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite),
      false
    )
    assert.equal(result.certificate, null)
  }
})

test('native class methods and lazy fields retain owner identities through closed native reads and returns', () => {
  const result = compileSource(`export {}
    class Base { method() { return 3 } }
    class Derived extends Base { method() { return 5 } }
    class Widget { label = 'widget'; describe = () => this.label }
    function read(value: Base) { return value.method }
    const base = new Base()
    const method = read(base)
    ;(method as unknown as { note?: number }).note = 23
    const widget = new Widget()
    ;(widget.describe as unknown as { tag?: string }).tag = 'native'
    console.log(method.call(base), (read(base) as unknown as { note?: number }).note, widget.describe())
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  assert.equal(operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite).length, 2)
  assert.match(result.source!, /gea::callableNativeDataSetWithReceiver/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet/)
})

test('an externally observed holder cannot lend closed native Function owner provenance', () => {
  const result = compileSource(`export {}
    declare function expose(value: unknown): void
    class Widget { describe = () => 'widget' }
    const widget = new Widget()
    expose(widget)
    ;(widget.describe as unknown as { tag?: string }).tag = 'must refuse'
  `)
  assert.equal(
    operationsOf(result).some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite),
    false
  )
  assert.equal(result.certificate, null)
})

test('a native field Function snapshot precedes a later dynamic receiver observation', () => {
  const result = compileSource(`export {}
    class Widget { describe = () => 'widget' }
    const widget = new Widget()
    ;(widget.describe as unknown as { tag?: string }).tag = 'native'
    const dynamic: any = widget
    console.log(dynamic.describe())
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const writes = operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite)
  assert.equal(writes.length, 1, JSON.stringify(result.refusals))
})

test('a conditional or parameter-owned field cannot borrow a fresh prefix snapshot', () => {
  for (const setup of [
    `declare const flag: boolean; const widget = flag ? new Widget() : new Widget()`,
    `declare function obtain(): Widget; const widget = obtain()`
  ]) {
    const result = compileSource(`export {}
      declare function expose(value: unknown): void
      class Widget { describe = () => 'widget' }
      ${setup}
      ;(widget.describe as unknown as { tag?: string }).tag = 'must refuse'
      expose(widget)
    `)
    assert.equal(
      operationsOf(result).some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite),
      false
    )
    assert.equal(result.certificate, null)
  }
})

test('a joined Function snapshot retains predecessor publication and rejects cyclic execution history', () => {
  for (const earlier of ['if (flag) expose(widget); else console.log("closed arm")', 'while (flag) console.log("iteration")']) {
    const result = compileSource(`export {}
      declare const flag: boolean
      declare function expose(value: unknown): void
      class Widget { describe = () => 'widget' }
      const widget = new Widget()
      ${earlier}
      ;(widget.describe as unknown as { tag?: string }).tag = 'must refuse'
      console.log((widget.describe as unknown as { tag?: string }).tag)
      expose(widget)
    `)
    assert.equal(
      operationsOf(result).some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite),
      false,
      earlier
    )
    assert.equal(result.certificate, null, earlier)
  }
})

test('ordinary readonly and integrity semantics remain on native Function writes', () => {
  const result = compileSource(`export {}
    function target() { return 1 }
    Object.freeze(target)
    Reflect.set(target, 'label', 42)
    ;(target as unknown as { name: string }).name = 'must throw'
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  assert.equal(
    operationsOf(result).filter((operation) => (operation.kind === 'set' || operation.kind === 'call') && operation.nativeCallableDataWrite)
      .length,
    2
  )
  assert.match(result.source!, /__gea_properties->freezeIntegrity\(\)/)
  assert.match(result.source!, /if \(!__gea_identity\) return __gea_callable;/)
  assert.match(result.source!, /if \(!\(\[&\]\(\) -> bool/)
})

test('native Function integrity queries and sealing preserve the original descriptor table', () => {
  const result = compileSource(`export {}
    const target = () => 1
    const sealed = Object.seal(target)
    const same = sealed === target
    const sealedState = Object.isSealed(target)
    const extensible = Object.isExtensible(target)
    const restricted = Object.preventExtensions(target)
    Object.freeze(target)
    const frozenState = Object.isFrozen(target)
    console.log(same, sealedState, extensible, restricted === target, frozenState)
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  assert.match(result.source!, /__gea_properties->defineOwnProperty\(__gea_key, __gea_update\)/)
  assert.match(result.source!, /__gea_properties->preventExtensions\(\)/)
  assert.match(result.source!, /__gea_properties->hasFrozenIntegrity\(\)/)
  assert.match(result.source!, /__gea_properties->extensible\(\)/)
  assert.match(result.source!, /if \(!__gea_identity\) return true;/)
  assert.match(result.source!, /if \(!__gea_identity\) return false;/)
})

test('unknown native Functions cannot borrow a native integrity receipt', () => {
  for (const source of [`export {}; declare function obtain(): () => number; const target = obtain(); Object.seal(target)`]) {
    const result = compileSource(source)
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.equal(result.certificate, null)
    assert.equal(
      operationsOf(result).some((operation) => operation.kind === 'call' && operation.nativeCallableIntegrity !== undefined),
      false
    )
    assert.ok(
      result.refusals.some((refusal) => refusal.key === 'call-abi:native-callable-integrity'),
      JSON.stringify(result.refusals)
    )
  }
})

test('native MakeConstructor storage precedes integrity and retains an exact physical backpointer', () => {
  const result = compileSource(`export {}
    function target(first?: number, ...rest: number[]) { return (first ?? 0) + rest.length }
    Object.freeze(target)
    const prototype: any = target.prototype
    console.log(Object.isFrozen(target), prototype.constructor === target, prototype.constructor(3, 4))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const prototypes = operationsOf(result).flatMap((operation) =>
    operation.kind === 'get' && operation.nativeCallablePrototype ? [operation.nativeCallablePrototype] : []
  )
  assert.equal(prototypes.length, 1)
  const proof = prototypes[0]!
  assert.equal(nativeCallablePrototypeMatches(proof, proof), true)
  assert.equal(nativeCallablePrototypeMatches(proof, { ...proof, allocation: 'unrelated-allocation' as IrValueId }), false)
  assert.equal(nativeCallablePrototypeMatches(proof, { ...proof, materialization: null }), false)
  assert.equal(nativeCallablePrototypeMatches(proof, { ...proof, entry: { ...proof.entry, restFrom: null } }), false)
  assert.match(result.source!, /gea::withNativeCallablePrototype\(/)
  assert.match(result.source!, /gea::installCallableNativePrototype\(__gea_callable\)/)
  assert.match(result.source!, /gea::callableNativeOwnPrototypeGet\(/)
  assert.doesNotMatch(result.source!, /installCallableConstructorPrototype|callableOwnPrototypeGet\(/)
})

test('native optional Function fields retain actual absence and reject substituted conversion receipts', () => {
  const result = compileSource(`export {}
    class Widget { describe = () => 'widget' }
    const present = new Widget()
    ;(present.describe as unknown as { tag?: string }).tag = 'native'
    const absent = new Widget()
    console.log((present.describe as unknown as { tag?: string }).tag, (absent.describe as unknown as { tag?: string }).tag)
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const reads = operationsOf(result).flatMap((operation) =>
    operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead ? [operation.nativeCallableDataSlot] : []
  )
  assert.equal(reads.length, 2)
  for (const proof of reads) {
    assert.equal(nativeCallableDataSlotMatches(proof, proof), true)
    assert.equal(
      nativeCallableDataSlotMatches(proof, { ...proof, optionalRead: { ...proof.optionalRead!, present: proof.optionalRead!.absent } }),
      false
    )
    assert.equal(nativeCallableDataSlotMatches(proof, { ...proof, key: 'other' }), false)
  }
  assert.match(result.source!, /ownProperty\(gea_data_key\)/)
  assert.match(result.source!, /readNativeData<std::string>/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicGet/)
})

test('a genuine erased Function observation publishes its original native prototype callback', () => {
  const result = compileSource(`export {}
    function target(value?: number, ...rest: number[]) { return (value ?? 0) + rest.length }
    const erased: any = target
    Object.freeze(target)
    console.log(erased.prototype.constructor === erased, erased.prototype.constructor(3, 4))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const observations = operationsOf(result).flatMap((operation) =>
    operation.kind === 'convert' && operation.nativeCallablePrototypeObservation ? [operation.nativeCallablePrototypeObservation] : []
  )
  assert.equal(observations.length, 1)
  assert.equal(observations[0]!.entry.restFrom, 1)
  assert.match(result.source!, /erased-prototype-backpointer|gea::installCallableNativePrototype\(/)
  assert.match(result.source!, /gea::Value::fromDynamicObject\(gea_table\)/)
})

test('a recursion-group Function installs its native prototype before its observed shared identity is copied', () => {
  const result = compileSource(`export {}
    function make() {
      function even(value: number): boolean { return value === 0 || odd(value - 1) }
      function odd(value: number): boolean { return value !== 0 && even(value - 1) }
      Object.freeze(even)
      const prototype: any = even.prototype
      return prototype.constructor === even
    }
    console.log(make())
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const installation = result.source!.split('\n').find((line) => /^v\d+ = gea::withNativeCallablePrototype\(/.test(line))
  assert.ok(installation)
  assert.match(installation, /withNativeCallablePrototype\(gea::identifyCallable<&gea_decl_tag_[^>]+>\(gea::CallableObject<bool\(double\)>/)
  assert.match(installation, /gea::sharedEnvironmentMember\(gea_group_\d+, &[^:]+::gea_identity_\d+\)\}\)\);$/)
})

test('a native class method authenticates its declaration prototype absence for integrity', () => {
  const result = compileSource(`export {}
    class Holder { method() { return 1 } }
    const target = new Holder().method
    Object.freeze(target)
    console.log(Object.isFrozen(target))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const receipts = operationsOf(result).flatMap((operation) =>
    operation.kind === 'call' && operation.nativeCallableIntegrity ? [operation.nativeCallableIntegrity] : []
  )
  assert.equal(receipts.length, 2)
  assert.ok(receipts.every((receipt) => receipt.ownPrototype === false && receipt.owners.length === 1))
})

test('an explicit different Reflect receiver cannot borrow the three-argument writer entry', () => {
  const result = compileSource(`export {}
    function target() { return 1 }
    function other() { return 2 }
    Reflect.set(target, 'label', 42, other)
  `)
  assert.equal(
    operationsOf(result).some((operation) => (operation.kind === 'set' || operation.kind === 'call') && operation.nativeCallableDataWrite),
    false
  )
  assert.equal(result.certificate, null)
})
