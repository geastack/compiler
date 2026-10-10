import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { IrBody } from './model.js'
import { nativePrototypePresenceDemandOf } from './native-prototype-presence-demand.js'
import { prototypeReadHooks } from '../targets/cpp/virtual-methods.js'
import { cppClassName } from '../targets/cpp/types.js'

const base: ClassLayout = {
  declaration: 'base' as DeclarationId,
  base: null,
  nativeBase: null,
  construct: null,
  instance: {
    kind: 'class-ref',
    declaration: 'base' as DeclarationId,
    shapeId: 'base-shape',
    ownership: 'shared-refcount',
    ancestors: []
  },
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: 'Base',
  length: 0
}
const child: ClassLayout = {
  ...base,
  declaration: 'child' as DeclarationId,
  base: base.declaration,
  methods: [{ key: 'method', callable: 'method-body' as never }],
  accessors: [{ key: 'watched', getter: 'getter-body' as never, setter: null }]
}
const unrelated: ClassLayout = { ...base, declaration: 'unrelated' as DeclarationId }
const classes = new Map([base, child, unrelated].map((layout) => [layout.declaration, layout]))

test('native Has demand closes the actual class family, including an empty base', () => {
  const body: IrBody = {
    owner: 'physical' as never,
    sourceOwner: 'source' as never,
    abi: null,
    construct: null,
    entry: 'entry' as never,
    blocks: new Map([
      [
        'entry' as never,
        {
          id: 'entry' as never,
          operations: [
            {
              kind: 'has-property',
              lineage: 'native-presence' as never,
              receiver: { value: 'receiver' as never, representation: base.instance! },
              key: { value: 'key' as never, representation: { kind: 'string' } },
              result: { id: 'result' as never, representation: { kind: 'scalar', domain: 'boolean' } }
            }
          ],
          terminator: { kind: 'return', lineage: null, value: null }
        }
      ]
    ]),
    blockOrder: ['entry' as never],
    values: new Map(),
    tryRegions: []
  }
  const demand = nativePrototypePresenceDemandOf([body], classes, { nodeById: () => null })
  assert.deepEqual([...demand], [base.declaration, child.declaration])
  const hooks = prototypeReadHooks(
    classes,
    () => null,
    () => false,
    () => false,
    new Map(),
    (id) => demand.has(id)
  )
  assert.match(hooks.membersByStruct.get(cppClassName(base.declaration))?.join('\n') ?? '', /virtual bool gea_hasPrototypeProperty/)
  assert.match(hooks.membersByStruct.get(cppClassName(child.declaration))?.join('\n') ?? '', /gea_hasPrototypeProperty.*override/)
  assert.equal(hooks.membersByStruct.has(cppClassName(unrelated.declaration)), false)
  const emitted = hooks.definitions.join('\n')
  assert.match(emitted, /method/)
  assert.match(emitted, /watched/)
  assert.doesNotMatch(emitted, /gea::Value|getter_body|box|gea_readPrototypeProperty/)
})

// A boxed instance reaches `in`/`Reflect.has` through the runtime's
// `NativePrototypeTable`, which installs a prototype table only for a type
// stating the whole read/has/set triple. Reflection therefore demands the Has
// hook beside the read hook even with no native Has observation; omitting it
// compiled the table out and a boxed getter read `undefined`.
test('value reflection states the whole prototype table without native Has demand', () => {
  const demand = nativePrototypePresenceDemandOf([], classes, { nodeById: () => null })
  assert.equal(demand.size, 0)
  const hooks = prototypeReadHooks(
    classes,
    () => null,
    () => false,
    () => true,
    new Map(),
    (id) => demand.has(id)
  )
  const members = hooks.membersByStruct.get(cppClassName(child.declaration))?.join('\n') ?? ''
  assert.match(members, /gea_readPrototypeProperty/)
  assert.match(members, /gea_hasPrototypeProperty/)
  assert.match(members, /gea_setPrototypeProperty\(/)
  assert.match(hooks.definitions.join('\n'), /gea_hasPrototypeProperty/)
})
