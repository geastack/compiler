import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createIrBodyBuilder } from './build.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { censusClassStaticFieldSlots } from './class-static-fields.js'
import type { IrOperand, IrOperation } from './model.js'
import { nativeConstructorAccessorEntryOf, nativeConstructorStaticCellOf } from './native-constructor-static.js'

const lineage = 'static-source' as never
const declaration = 'StaticSource' as DeclarationId
const getterId = 'static-getter' as FunctionId
const trapId = 'static-trap' as FunctionId
const string: Representation = { kind: 'string' }
const voidAbi: CallableAbi = { receiver: null, parameters: [], result: { kind: 'void' }, restFrom: null }
const callable: Representation = { kind: 'function-value-dispatch', abi: voidAbi }
const target: Representation = { kind: 'record', shapeId: 'static-target', fields: [], accessors: [], ownership: 'shared-refcount' }
const handler: Representation = {
  kind: 'record',
  shapeId: 'static-handler',
  fields: [{ key: 'get', value: callable, required: true }],
  accessors: [],
  ownership: 'shared-refcount'
}
const proxy: Representation = { kind: 'proxy-object', target, handler }
const constructor: Representation = { kind: 'constructor-family', members: [declaration], abi: voidAbi }
const operand = (value: IrValueId, representation: Representation): IrOperand => ({ value, representation })
const layout = (id: DeclarationId, base: DeclarationId | null = null): ClassLayout => ({
  declaration: id,
  name: String(id),
  length: 0,
  base,
  nativeBase: null,
  construct: null,
  instance: null,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: []
})

const fixture = (unknownGetter = false, publishConstructor = false) => {
  const classes = new Map<DeclarationId, ClassLayout>([
    [
      declaration,
      {
        ...layout(declaration),
        staticFields: [{ declaration: 'static-cell' as never, key: '_sdk', representation: proxy, initializer: null } as never],
        staticAccessors: [{ key: 'sdk', getter: getterId, setter: null }]
      }
    ]
  ])
  const builder = createIrBodyBuilder('static-module' as never, 'static-module' as never, null)
  const entry = builder.openBlock()
  const classValue = builder.allocateConstructor(entry, lineage, declaration, [], constructor)
  builder.bindingWrite(entry, lineage, 'class-binding' as never, operand(classValue, constructor))
  const trap = builder.allocateCallable(entry, lineage, trapId, [], callable)
  const plain = builder.allocateRecord(entry, lineage, [], target)
  const traps = builder.allocateRecord(entry, lineage, [{ key: 'get', value: operand(trap, callable) }], handler)
  const actualProxy = builder.allocateProxy(entry, lineage, operand(plain, target), operand(traps, handler), proxy)
  const cellKey = builder.constant(entry, lineage, '_sdk', 'string', string)
  builder.set(entry, lineage, operand(classValue, constructor), operand(cellKey, string), operand(actualProxy, proxy), true, constructor)
  if (publishConstructor) {
    const consumer: Representation = {
      kind: 'function-value-dispatch',
      abi: { ...voidAbi, parameters: [{ value: constructor, passing: 'by-value', ownership: 'owned' }] }
    }
    const external = builder.bindingRead(entry, lineage, 'external-consumer' as never, consumer)
    builder.call(entry, lineage, operand(external, consumer), null, [operand(classValue, constructor)], null)
  }
  const publicKey = builder.constant(entry, lineage, 'sdk', 'string', string)
  const read = builder.get(entry, lineage, operand(classValue, constructor), operand(publicKey, string), proxy)
  const selectedHandler = builder.proxyPart(entry, lineage, operand(read, proxy), 'handler', handler)
  const trapKey = builder.constant(entry, lineage, 'get', 'string', string)
  const trapRead = builder.get(entry, lineage, operand(selectedHandler, handler), operand(trapKey, string), callable)
  builder.return(entry, null, null)
  const root = builder.seal()

  const getter = createIrBodyBuilder('static-getter-body' as never, getterId, { ...voidAbi, result: proxy })
  const getterEntry = getter.openBlock()
  const heldClass = getter.bindingRead(getterEntry, lineage, 'class-binding' as never, constructor)
  const heldKey = getter.constant(getterEntry, lineage, '_sdk', 'string', string)
  const heldValue = getter.get(getterEntry, lineage, operand(heldClass, constructor), operand(heldKey, string), proxy)
  getter.return(getterEntry, lineage, operand(heldValue, proxy))
  const actualGetter = getter.seal()
  const trapBody = createIrBodyBuilder('static-trap-body' as never, trapId, voidAbi)
  const trapEntry = trapBody.openBlock()
  trapBody.return(trapEntry, null, null)
  const bodies = [root, trapBody.seal(), ...(unknownGetter ? [] : [actualGetter])]
  const placements = new Map<DeclarationId, BindingPlacement>([
    [
      'class-binding' as never,
      {
        storage: { kind: 'region', owner: 'static-module' as never },
        representation: constructor
      }
    ]
  ])
  const publicGet = [...root.blocks.values()]
    .flatMap((block) => block.operations)
    .find((operation) => operation.kind === 'get' && operation.result.id === read)!
  return { classes, bodies, root, actualGetter, publicGet, trapRead, placements }
}

test('an actual static getter reads the original Proxy and its private trap through the compiler-owned cell', () => {
  const { classes, bodies, placements, trapRead } = fixture()
  const flow = nativeCallableFlowOf(bodies, placements, classes)
  assert.deepEqual(flow.callables.get(trapRead), { kind: 'exact', functionId: trapId })
})

test('unknown getter bodies and publication of the constructor cannot retain a closed static source', () => {
  for (const [unknownGetter, publishConstructor] of [
    [true, false],
    [false, true]
  ]) {
    const { classes, bodies, placements, trapRead } = fixture(unknownGetter, publishConstructor)
    assert.equal(
      nativeCallableFlowOf(bodies, placements, classes).callables.has(trapRead),
      false,
      unknownGetter ? 'missing getter body' : 'constructor publication'
    )
  }
})

test('static accessor provenance authenticates the selected active body and exact physical frame', () => {
  const { classes, publicGet, actualGetter } = fixture()
  assert.equal(nativeConstructorAccessorEntryOf(publicGet, 'sdk', classes, () => actualGetter)?.functionId, getterId)
  assert.equal(
    nativeConstructorAccessorEntryOf(publicGet, 'sdk', classes, () => null),
    null
  )
  assert.equal(
    nativeConstructorAccessorEntryOf(publicGet, 'sdk', classes, () => ({ ...actualGetter, sourceOwner: 'other' as never })),
    null
  )
  assert.equal(
    nativeConstructorAccessorEntryOf(publicGet, 'sdk', classes, () => ({ ...actualGetter, async: true })),
    null
  )
  assert.equal(
    nativeConstructorAccessorEntryOf(publicGet, 'sdk', classes, () => ({
      ...actualGetter,
      abi: { ...actualGetter.abi!, parameters: [{ value: string, passing: 'by-value', ownership: 'owned' }] }
    })),
    null
  )
})

test('inherited static cells and getter overrides follow the emitted storage and member owners', () => {
  const { classes, publicGet, actualGetter, bodies } = fixture()
  const child = 'StaticChild' as DeclarationId
  classes.set(child, layout(child, declaration))
  const receiver: Representation = { kind: 'constructor-family', members: [child], abi: voidAbi }
  const inheritedGet: IrOperation = {
    ...(publicGet as Extract<IrOperation, { kind: 'get' }>),
    receiver: { value: 'child' as never, representation: receiver }
  }
  assert.equal(nativeConstructorAccessorEntryOf(inheritedGet, 'sdk', classes, () => actualGetter)?.functionId, getterId)
  const cellGet: IrOperation = {
    ...(inheritedGet as Extract<IrOperation, { kind: 'get' }>),
    key: { value: 'cell-key' as never, representation: string }
  }
  assert.equal(nativeConstructorStaticCellOf(cellGet, '_sdk', classes, censusClassStaticFieldSlots(bodies, classes))?.owner, declaration)
  const childGetter = 'child-getter' as FunctionId
  classes.set(child, { ...layout(child, declaration), staticAccessors: [{ key: 'sdk', getter: childGetter, setter: null }] })
  assert.equal(
    nativeConstructorAccessorEntryOf(inheritedGet, 'sdk', classes, () => actualGetter),
    null
  )
  assert.equal(
    nativeConstructorAccessorEntryOf(inheritedGet, 'sdk', classes, (id) =>
      id === childGetter ? { ...actualGetter, sourceOwner: childGetter } : null
    )?.functionId,
    childGetter
  )
})

test('an own static getter shadows an inherited data cell of the same key', () => {
  const { classes, publicGet, actualGetter, bodies } = fixture()
  const child = 'ShadowingStaticChild' as DeclarationId
  const shadowGetter = 'shadowing-static-getter' as FunctionId
  classes.set(child, { ...layout(child, declaration), staticAccessors: [{ key: '_sdk', getter: shadowGetter, setter: null }] })
  const receiver: Representation = { kind: 'constructor-family', members: [child], abi: voidAbi }
  const read: IrOperation = {
    ...(publicGet as Extract<IrOperation, { kind: 'get' }>),
    receiver: { value: 'child' as never, representation: receiver }
  }
  const slots = censusClassStaticFieldSlots(bodies, classes)
  assert.equal(nativeConstructorStaticCellOf(read, '_sdk', classes, slots), null)
  assert.equal(
    nativeConstructorAccessorEntryOf(read, '_sdk', classes, (id) =>
      id === shadowGetter ? { ...actualGetter, sourceOwner: shadowGetter } : null
    )?.functionId,
    shadowGetter
  )
})
