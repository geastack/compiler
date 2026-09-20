import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodFamilyMutableOf, classPrototypeMethodMutableOf } from './fields.js'
import { keyExcludesSymbols } from './classes.js'
import type { Representation } from '../representation/model.js'

const compileFixture = (source: string, projectFileName: string | null = null) => {
  const entry = resolve('test/runtime/projected-method-overrides.ts')
  return compile({ rootFileNames: [entry], projectFileName, sourceOverlay: new Map([[entry, source]]), includeIr: true })
}

test('an inherited method assignment reserves one absent native slot with the method receiver ABI', () => {
  const result = compileFixture(`
    class Base { hook(): number { return 1 } stable(): number { return 3 } }
    class Child extends Base {}
    const a = new Child(), b = new Child();
    a.hook = () => 2;
    console.log(a.hook === b.hook, a.hook(), b.hook(), a.stable());
  `)
  const classes = result.projection.classes
  const base = [...classes.values()].find((layout) => layout.name === 'Base')!
  const child = [...classes.values()].find((layout) => layout.name === 'Child')!
  assert.ok(base && child)
  const field = classMethodOverrideOf(classes, child.declaration, 'hook')
  assert.ok(field)
  assert.equal(field, classMethodOverrideOf(classes, base.declaration, 'hook'))
  assert.equal(field.required, false)
  assert.equal(field.value.kind, 'function-value-dispatch')
  if (field.value.kind !== 'function-value-dispatch') return
  assert.equal(field.value.abi.receiver?.kind, 'class-ref')
  if (field.value.abi.receiver?.kind === 'class-ref') assert.equal(field.value.abi.receiver.declaration, base.declaration)
  assert.equal(classMemberOf(classes, child.declaration, 'hook')?.kind, 'method')
  assert.equal(classMethodOverrideOf(classes, child.declaration, 'stable'), null)
  assert.equal(classPrototypeMethodMutableOf(classes, base.declaration, 'hook'), false)
  assert.equal(child.methodOverrides, undefined)
  assert.equal(base.nativeStorage?.fields.find((item) => item.key === 'hook')?.required, false)
  const hook = base.methods.find((method) => method.key === 'hook')!.callable
  let keepsDefaultAndReplacement = false
  for (const body of result.irBodies ?? [])
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind === 'call' && operation.target?.kind === 'direct') assert.notEqual(operation.target.functionId, hook)
        if (operation.kind === 'get' && operation.closedCallable?.kind === 'closed-family')
          keepsDefaultAndReplacement ||=
            operation.closedCallable.functionIds.includes(hook!) && operation.closedCallable.functionIds.length > 1
      }
  assert.ok(keepsDefaultAndReplacement, 'mutable method provenance includes both its prototype and assigned callable')
})

test('prototype writes through binding aliases invalidate super while sharing the original typed method slot', () => {
  const result = compileFixture(`
    class Base { hook(): number { return 1 } }
    class Child extends Base { run(): number { return super.hook() } }
    const prototype = Base.prototype;
    const alias = prototype;
    alias.hook = () => 3;
    console.log(new Child().run());
  `)
  const classes = result.projection.classes
  const base = [...classes.values()].find((layout) => layout.name === 'Base')!
  const child = [...classes.values()].find((layout) => layout.name === 'Child')!
  assert.ok(base && child)
  assert.equal(classPrototypeMethodMutableOf(classes, base.declaration, 'hook'), true)
  assert.equal(classPrototypeMethodMutableOf(classes, child.declaration, 'hook'), true)
  assert.equal(classMethodOverrideOf(classes, child.declaration, 'hook'), classMethodOverrideOf(classes, base.declaration, 'hook'))
  const hook = base.methods.find((method) => method.key === 'hook')!.callable
  for (const body of result.irBodies ?? [])
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'call' && operation.target?.kind === 'direct') assert.notEqual(operation.target.functionId, hook)
})

test('unmodified prototype methods do not gain own storage or lose their direct-call proof', () => {
  const result = compileFixture(`class Base { hook(): number { return 1 } } console.log(new Base().hook());`)
  const layout = [...result.projection.classes.values()].find((item) => item.name === 'Base')!
  assert.ok(layout)
  assert.equal(layout.methodOverrides, undefined)
  const hook = layout.methods.find((method) => method.key === 'hook')!.callable
  assert.ok(
    (result.irBodies ?? []).some((body) =>
      [...body.blocks.values()].some((block) =>
        block.operations.some(
          (operation) => operation.kind === 'call' && operation.target?.kind === 'direct' && operation.target.functionId === hook
        )
      )
    )
  )
})

test('mutable method storage retains its public arguments independently of the initial body frame', () => {
  const result = compileFixture(`
    class Base { hook(a: number, b: number, c: number): void; hook(): void {} }
    class Child extends Base {}
    const value = new Child();
    value.hook = function(this: Base, a: number, b: number, c: number): void { console.log(a + b + c) };
    function invoke(target: Base): void { target.hook(1, 2, 3) }
    invoke(value);
  `)
  assert.equal(result.diagnostics.clean, true)
  const layout = [...result.projection.classes.values()].find((item) => item.name === 'Base')!
  assert.equal(layout.constructor, null, 'an assigned ordinary callback is not a class constructor')
  const method = layout.methods.find((item) => item.key === 'hook')!
  assert.equal(method.representation?.kind, 'function-value-dispatch')
  assert.equal(method.storageRepresentation?.kind, 'function-value-dispatch')
  if (method.representation?.kind !== 'function-value-dispatch' || method.storageRepresentation?.kind !== 'function-value-dispatch') return
  assert.equal(method.representation.abi.parameters.length, 0)
  assert.equal(method.storageRepresentation.abi.parameters.length, 3)
  const field = classMethodOverrideOf(result.projection.classes, layout.declaration, 'hook')!
  assert.deepEqual(field.value, method.storageRepresentation)
})

test('written constructors retain explicit ownership beside ordinary callbacks with the same receiver ABI', () => {
  const result = compileFixture(`
    class Owner { constructor(public value: number) {} }
    const instance = new Owner(5);
    const callback = function(this: Owner, value: number): void { this.value = value };
    callback.call(instance, 6);
    console.log(instance.value);
  `)
  const layout = [...result.projection.classes.values()].find((item) => item.name === 'Owner')!
  const allocation = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'allocation' && operation.classConstructorBodyOf === layout.declaration
  )
  assert.equal(allocation?.family, 'allocation')
  if (allocation?.family !== 'allocation') return
  assert.equal(layout.constructor, allocation.callable)
  assert.notEqual(layout.constructor, null)
})

test('an inferred helper receiver reads the same public mutable method frame as an annotated receiver', () => {
  const result = compileFixture(
    `
    class Base { hook(a: number, b: number, c: number): void; hook(): void {} }
    class Child extends Base {}
    const value = new Child();
    value.hook = function(this: Base, a: number, b: number, c: number): void { console.log(a + b + c) };
    function invoke(target) { target.hook(1, 2, 3) }
    invoke(value);
  `,
    resolve('test/runtime/native-method-inferred-parameters.tsconfig.json')
  )
  assert.equal(result.diagnostics.clean, true)
  let methodCalls = 0
  for (const body of result.irBodies ?? [])
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'call' || operation.receiver?.representation.kind !== 'class-ref') continue
        const callee = operation.callee.representation
        assert.equal(callee.kind, 'function-value-dispatch')
        if (callee.kind !== 'function-value-dispatch') continue
        assert.equal(callee.abi.parameters.length, 3)
        methodCalls++
      }
  assert.ok(methodCalls > 0)
})

// The key is a parameter so its declared domain reaches the write unnarrowed;
// three.js spells this write in plain JavaScript (`vector[ key ] = value`).
const symbolIteratorClass = (keyType: string) => `
  class Vec {
    x = 1
    scale(k: number): number { return this.x * k }
    *[Symbol.iterator](): Generator<number> { yield this.x }
  }
  function write(target: Vec, key: ${keyType}): void {
    // @ts-expect-error -- a runtime-keyed write
    target[key] = (k: number) => k
  }
  const v = new Vec();
  write(v, String(Math.random()));
  console.log(v.scale(2));
  for (const item of v) console.log(item);
`

test('a runtime string key reserves own slots for string-keyed methods only, never a symbol-keyed one', () => {
  const result = compileFixture(symbolIteratorClass('string'))
  const layout = [...result.projection.classes.values()].find((item) => item.name === 'Vec')!
  assert.ok(layout)
  assert.ok(
    layout.methods.some((method) => method.key.startsWith('sym(')),
    'the generator method is still a prototype method'
  )
  const keys = (layout.methodOverrides ?? []).map((field) => field.key)
  assert.ok(keys.includes('scale'))
  assert.deepEqual(
    keys.filter((key) => key.startsWith('sym(')),
    []
  )
  assert.deepEqual(
    (layout.nativeStorage?.fields ?? []).filter((field) => field.key.startsWith('sym(')),
    []
  )
})

test('a runtime key that may be a symbol keeps the symbol-keyed method slot', () => {
  const result = compileFixture(symbolIteratorClass('PropertyKey'))
  const layout = [...result.projection.classes.values()].find((item) => item.name === 'Vec')!
  assert.ok(layout)
  const keys = (layout.methodOverrides ?? []).map((field) => field.key)
  assert.ok(keys.includes('scale'))
  assert.ok(keys.some((key) => key.startsWith('sym(')))
})

test('only primitive non-symbol key carriers exclude symbol keys', () => {
  const string: Representation = { kind: 'string' }
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const arm = (value: Representation, index: number) => ({
    tag: 'object',
    value,
    semanticType: `arm-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' } as const
  })
  for (const carrier of [
    string,
    number,
    { kind: 'optional', absence: 'undefined', payload: string },
    { kind: 'tagged-union', arms: [string, number].map(arm) }
  ] as Representation[])
    assert.equal(keyExcludesSymbols(carrier), true)
  for (const carrier of [
    { kind: 'symbol' },
    { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    { kind: 'record', shapeId: 'key-object', fields: [], accessors: [], ownership: 'owned' },
    { kind: 'tagged-union', arms: [] },
    { kind: 'tagged-union', arms: [string, { kind: 'symbol' } as Representation].map(arm) }
  ] as Representation[])
    assert.equal(keyExcludesSymbols(carrier), false)
})

test('derived prototype mutation affects base-typed instances but not a base super lookup', () => {
  const result = compileFixture(`
    class Base { hook(): number { return 1 } }
    class Child extends Base {}
    Child.prototype.hook = () => 3;
    const instance: Base = new Child();
    console.log(instance.hook());
  `)
  const classes = result.projection.classes
  const base = [...classes.values()].find((layout) => layout.name === 'Base')!
  const child = [...classes.values()].find((layout) => layout.name === 'Child')!
  assert.ok(base && child)
  assert.equal(classPrototypeMethodMutableOf(classes, base.declaration, 'hook'), false)
  assert.equal(classPrototypeMethodMutableOf(classes, child.declaration, 'hook'), true)
  assert.equal(classPrototypeMethodFamilyMutableOf(classes, base.declaration, 'hook'), true)
  assert.equal(base.prototypeUnsupportedUses, undefined)
  assert.equal(child.prototypeUnsupportedUses, undefined)
})
