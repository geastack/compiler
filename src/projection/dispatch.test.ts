import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { ClassLayout } from './classes.js'
import {
  classMethodValueArmsOf,
  classPrototypeMethodValueArmsOf,
  classPrototypeMethodKeysOf,
  virtualDispatchVerdictOf
} from './dispatch.js'

const base = 'dispatch-base' as DeclarationId
const derived = 'dispatch-derived' as DeclarationId
const baseMethod = 'dispatch-base-method' as FunctionId
const derivedMethod = 'dispatch-derived-method' as FunctionId
const number: Representation = { kind: 'scalar', domain: 'number' }
const instance = (declaration: DeclarationId): Representation => ({
  kind: 'class-ref',
  declaration,
  shapeId: declaration,
  ancestors: declaration === derived ? [base] : [],
  ownership: 'shared-refcount'
})
const layout = (declaration: DeclarationId, callable: FunctionId): ClassLayout => ({
  declaration,
  base: declaration === derived ? base : null,
  nativeBase: null,
  instance: instance(declaration),
  construct: null,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  accessors: [],
  methods: [{ key: 'read', callable }],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
})
const classes = new Map([
  [base, layout(base, baseMethod)],
  [derived, layout(derived, derivedMethod)]
])
const abi = (declaration: DeclarationId, result: Representation = number): CallableAbi => ({
  receiver: instance(declaration),
  parameters: [{ value: number, passing: 'by-value', ownership: 'owned' }],
  result,
  restFrom: null
})
const verdict = (root = abi(base), override = abi(derived), capturing = false) =>
  virtualDispatchVerdictOf(
    classes,
    (id) => (id === baseMethod ? root : override),
    () => !capturing,
    createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  )

test('method values select the nearest implementation for each exact allocation, including inherited overrides', () => {
  const leaf = 'dispatch-leaf' as DeclarationId
  const family = new Map(classes)
  family.set(leaf, { ...layout(leaf, derivedMethod), base: derived, methods: [] })
  assert.deepEqual(
    classMethodValueArmsOf(family, base, 'read')?.map((arm) => [arm.allocation, arm.method.callable]),
    [
      [base, baseMethod],
      [derived, derivedMethod],
      [leaf, derivedMethod]
    ]
  )
  family.set(leaf, { ...family.get(leaf)!, accessors: [{ key: 'read', getter: derivedMethod, setter: null }] })
  assert.equal(classMethodValueArmsOf(family, base, 'read'), null, 'an accessor is an invocation, not a method value')
})

test('prototype reads preserve subclass-only methods and absence without weakening callable-family proof', () => {
  const family = new Map(classes)
  family.set(base, { ...layout(base, baseMethod), methods: [] })
  assert.deepEqual(classPrototypeMethodKeysOf(family, base), ['read'])
  assert.deepEqual(
    classPrototypeMethodValueArmsOf(family, base, 'read')?.map((arm) => [arm.allocation, arm.method?.callable ?? null]),
    [
      [base, null],
      [derived, derivedMethod]
    ]
  )
  assert.equal(classMethodValueArmsOf(family, base, 'read'), null, 'a required callable still needs every arm')
  family.set(derived, { ...family.get(derived)!, methods: [], accessors: [{ key: 'read', getter: derivedMethod, setter: null }] })
  assert.equal(classPrototypeMethodValueArmsOf(family, base, 'read'), null, 'a getter must not be mistaken for a method')
})

test('virtual dispatch publishes native transport despite different implementation receivers', () => {
  const result = verdict()
  assert.equal(result.refused.length, 0)
  assert.equal(result.families.length, 1)
  assert.equal(result.families[0]?.nativeFieldProtocol, 'unused')
  assert.deepEqual(result.families[0]?.rootAbi, abi(base))
})

test('boxing result adapters and capturing overrides never acquire native transport proof', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const boxed = verdict(abi(base, dynamic))
  assert.equal(boxed.refused.length, 0)
  assert.equal(boxed.families.length, 1)
  assert.equal(boxed.families[0]?.nativeFieldProtocol, undefined)
  const capturing = verdict(abi(base), abi(derived), true)
  assert.equal(capturing.families.length, 0)
  assert.equal(capturing.refused.length, 1)
})
