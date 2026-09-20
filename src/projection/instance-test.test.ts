import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClassLayout } from './classes.js'
import type { Representation } from '../representation/model.js'
import { classInstanceTestOf, noClassPrototypes, type ClassPrototypeFacts } from './instance-test.js'

const base = 'instance-base' as never
const derived = 'instance-derived' as never
const unrelated = 'instance-unrelated' as never
const classes = new Map([
  [base, { base: null } as unknown as ClassLayout],
  [derived, { base } as unknown as ClassLayout],
  [unrelated, { base: null } as unknown as ClassLayout]
])
const ref = (declaration = base): Representation => ({
  kind: 'class-ref',
  declaration,
  shapeId: 'instance-type',
  ancestors: [],
  ownership: 'shared-refcount'
})
const constructor = (members = [base]): Representation => ({ kind: 'constructor-family', members, abi: null }) as never

test('class membership distinguishes a nullable upcast from a checked descendant test', () => {
  assert.deepEqual(classInstanceTestOf(ref(derived), constructor(), classes, noClassPrototypes), {
    test: { kind: 'present' },
    nativeFieldProtocol: 'unused'
  })
  assert.deepEqual(classInstanceTestOf(ref(), constructor([derived]), classes, noClassPrototypes), {
    test: { kind: 'class-family', members: [derived], boxed: false },
    nativeFieldProtocol: 'unused'
  })
  assert.deepEqual(classInstanceTestOf(ref(unrelated), constructor(), classes, noClassPrototypes)?.test, { kind: 'constant', value: false })
})

test('nested presence and union tests retain discriminant positions and dynamic boundaries', () => {
  const sum: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'null', value: { kind: 'null' } },
      { tag: 'object', value: { kind: 'optional', absence: 'undefined', payload: ref() } }
    ]
  } as never
  const recipe = classInstanceTestOf(sum, constructor([derived]), classes, noClassPrototypes)
  assert.equal(recipe?.nativeFieldProtocol, 'unused')
  assert.deepEqual(recipe?.test, {
    kind: 'union',
    arms: [
      {
        index: 1,
        test: {
          kind: 'optional',
          payload: {
            kind: 'class-family',
            members: [derived],
            boxed: false
          }
        }
      }
    ]
  })
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.equal(classInstanceTestOf(dynamic, constructor(), classes, noClassPrototypes)?.nativeFieldProtocol, undefined)
  assert.deepEqual(classInstanceTestOf(dynamic, constructor(), classes, noClassPrototypes)?.test, {
    kind: 'class-family',
    members: [base, derived],
    boxed: true
  })
  assert.equal(classInstanceTestOf(ref(), dynamic, classes, noClassPrototypes), undefined)
})

test('typed-array membership keeps every nested sum and absence guard', () => {
  const array: Representation = { kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' }
  const other: Representation = { kind: 'typed-array', element: 'uint32', buffer: 'array-buffer', ownership: 'shared-refcount' }
  const sum = (...values: Representation[]): Representation => ({
    kind: 'tagged-union',
    arms: values.map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `instance-type-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  })
  const target = { kind: 'native-handle', protocol: 'Float32ArrayConstructor' } as Representation
  const nested = sum({ kind: 'null' }, sum(other, { kind: 'optional', absence: 'undefined', payload: array }))
  assert.deepEqual(classInstanceTestOf(nested, target, classes, noClassPrototypes), {
    test: {
      kind: 'union',
      arms: [
        {
          index: 1,
          test: {
            kind: 'union',
            arms: [{ index: 1, test: { kind: 'optional', payload: { kind: 'present' } } }]
          }
        }
      ]
    },
    nativeFieldProtocol: 'unused'
  })
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const opaque = classInstanceTestOf(sum(other, sum(array, dynamic)), target, classes, noClassPrototypes)
  assert.equal(opaque?.nativeFieldProtocol, undefined)
  assert.ok(JSON.stringify(opaque?.test).includes('boxed-typed-array'))
  assert.deepEqual(classInstanceTestOf(other, target, classes, noClassPrototypes)?.test, { kind: 'constant', value: false })
  assert.equal(
    classInstanceTestOf(array, { kind: 'native-handle', protocol: 'UserArrayConstructor' } as Representation, classes, noClassPrototypes),
    undefined
  )
})

test('a right-hand side that is not an Object throws before reading the left operand', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const cases: readonly [Representation, string][] = [
    [{ kind: 'undefined' }, 'undefined'],
    [{ kind: 'null' }, 'null'],
    [{ kind: 'string' }, 'string'],
    [{ kind: 'symbol' }, 'symbol'],
    [{ kind: 'scalar', domain: 'boolean' }, 'boolean'],
    [{ kind: 'scalar', domain: 'bigint' }, 'bigint'],
    [{ kind: 'scalar', domain: 'int32' }, 'number']
  ]
  for (const [right, target] of cases)
    for (const left of [ref(), dynamic])
      assert.deepEqual(classInstanceTestOf(left, right, classes, noClassPrototypes), {
        test: { kind: 'throws-non-object', target },
        nativeFieldProtocol: 'unused'
      })
  assert.equal(classInstanceTestOf(ref(), dynamic, classes, noClassPrototypes), undefined, 'a boxed constructor keeps its prototype walk')
  assert.equal(
    classInstanceTestOf(ref(), { kind: 'optional', absence: 'undefined', payload: constructor() }, classes, noClassPrototypes),
    undefined
  )
})

test('a class prototype object is an instance only of the classes its own class strictly extends', () => {
  const prototypeOf = (declaration: never, materialized: readonly never[] = [declaration]): ClassPrototypeFacts => ({
    prototypeOf: declaration,
    materialized: new Set(materialized)
  })
  const constant = (value: boolean) => ({ test: { kind: 'constant', value }, nativeFieldProtocol: 'unused' })
  // `C.prototype instanceof C`: its chain starts at C's base's prototype.
  assert.deepEqual(classInstanceTestOf(ref(), constructor(), classes, prototypeOf(base)), constant(false))
  assert.deepEqual(classInstanceTestOf(ref(derived), constructor([derived]), classes, prototypeOf(derived)), constant(false))
  // `Sub.prototype instanceof Base`: Base.prototype is on that chain.
  assert.deepEqual(classInstanceTestOf(ref(derived), constructor(), classes, prototypeOf(derived)), constant(true))
  // `new C() instanceof C` where no prototype object exists stays the presence test.
  assert.deepEqual(classInstanceTestOf(ref(), constructor(), classes, noClassPrototypes), {
    test: { kind: 'present' },
    nativeFieldProtocol: 'unused'
  })
  // A carrier that may hold C's prototype object or an instance reads which
  // one it holds at runtime (`instanceOfClassFamilyRef`), over the whole family.
  const either: ClassPrototypeFacts = { prototypeOf: null, materialized: new Set([base]) }
  assert.deepEqual(classInstanceTestOf(ref(), constructor(), classes, either), {
    test: { kind: 'class-family', members: [base, derived], boxed: false },
    nativeFieldProtocol: 'unused'
  })
  assert.deepEqual(classInstanceTestOf({ kind: 'optional', absence: 'undefined', payload: ref() }, constructor(), classes, either)?.test, {
    kind: 'optional',
    payload: { kind: 'class-family', members: [base, derived], boxed: false }
  })
  // A derived carrier cannot hold the base's prototype, and a derived
  // prototype IS an instance of the base: neither needs the runtime read.
  assert.deepEqual(classInstanceTestOf(ref(derived), constructor(), classes, either)?.test, { kind: 'present' })
  const derivedPrototype: ClassPrototypeFacts = { prototypeOf: null, materialized: new Set([derived]) }
  assert.deepEqual(classInstanceTestOf(ref(), constructor(), classes, derivedPrototype)?.test, { kind: 'present' })
  // An owned copy and a box cannot tell the prototype object apart: refused.
  assert.equal(classInstanceTestOf({ ...ref(), ownership: 'owned' } as Representation, constructor(), classes, either), undefined)
  // A box re-reads a member at its own class and tells its prototype object
  // from an instance (`instanceOfClassFamily`), so a carrier that may hold
  // the base's prototype object is tested over the family, not refused.
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.deepEqual(classInstanceTestOf(dynamic, constructor(), classes, either)?.test, {
    kind: 'class-family',
    members: [base, derived],
    boxed: true
  })
  assert.deepEqual(classInstanceTestOf(dynamic, constructor(), classes, derivedPrototype)?.test, {
    kind: 'class-family',
    members: [base, derived],
    boxed: true
  })
})
