import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

const compileText = (text: string) => {
  const file = resolve('test/runtime/reflect-native-boundary.ts')
  return compile({ rootFileNames: [file], projectFileName: null, sourceOverlay: new Map([[file, text]]), includeIr: true })
}
test('Reflect field effects survive their exact native ABI', () => {
  const result = compileText(`const record = { value: 42 };
    console.log(Reflect.has(record, 'value'), Reflect.get(record, 'value'),
      Reflect.set(record, 'value', 43), Reflect.deleteProperty(record, 'value'))`)
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.deepEqual(result.emissionRefusals, [])
  const operations = [...result.graph.operations.values()].filter((operation) => operation.family === 'invocation')
  assert.deepEqual(
    operations.flatMap((operation) => (operation.intrinsicReflection ? [operation.intrinsicReflection] : [])),
    ['has', 'get', 'set', 'deleteProperty']
  )
  const demand = [...result.reflection!.records.values()].find((entry) => entry.fieldOperations?.has('value'))
  assert.ok(demand)
  assert.ok(demand.fieldOperations!.get('value')!.has('native-read'))
  assert.ok(demand.fieldOperations!.get('value')!.has('native-write'))
})

test('native Reflect reads keep inherited and own field initializers reachable', () => {
  for (const key of ["'detail'", "String('detail')"]) {
    const result = compileText(`
      class Base { inherited = 1 }
      class Child extends Base { detail = 2 }
      const instance = new Child();
      console.log(Reflect.get(instance, 'inherited') as number, Reflect.get(instance, ${key}) as number);
    `)
    assert.ok(result.certificate, JSON.stringify(result.refusals))
    assert.deepEqual(result.emissionRefusals, [])
    for (const [name, field] of [
      ['Base', 'inherited'],
      ['Child', 'detail']
    ] as const) {
      const layout = [...result.projection.classes.values()].find((entry) => entry.name === name)
      assert.ok(layout)
      const initializer = layout.fields.find((entry) => entry.key === field)?.initializer
      assert.ok(initializer)
      assert.ok(
        result.irBodies?.some((body) => body.sourceOwner === initializer),
        `${name}.${field} initializer must remain live`
      )
    }
  }
})

test('Reflect writes, presence, deletion and key queries preserve initializer side effects', () => {
  for (const operation of [
    "Reflect.set(instance, 'detail', 9)",
    "Reflect.has(instance, 'detail')",
    "Reflect.deleteProperty(instance, 'detail')",
    'Reflect.ownKeys(instance)'
  ]) {
    const result = compileText(`
      function initialize(): number { console.log('initialized'); return 2 }
      class Base { inherited = 1 }
      class Child extends Base { detail = initialize() }
      const instance = new Child();
      ${operation};
    `)
    assert.ok(result.certificate, JSON.stringify(result.refusals))
    assert.deepEqual(result.emissionRefusals, [])
    const child = [...result.projection.classes.values()].find((entry) => entry.name === 'Child')!
    const initializer = child.fields.find((entry) => entry.key === 'detail')?.initializer
    assert.ok(initializer)
    assert.ok(
      result.irBodies?.some((body) => body.sourceOwner === initializer),
      operation
    )
  }
})

test('authenticated property descriptors observe initialized field values', () => {
  for (const owner of ['Object', 'Reflect']) {
    for (const key of ["'detail'", "String('detail')"]) {
      const result = compileText(`
        class Item { detail = 2 }
        console.log(${owner}.getOwnPropertyDescriptor(new Item(), ${key})?.value);
      `)
      assert.ok(result.certificate, JSON.stringify(result.refusals))
      assert.deepEqual(result.emissionRefusals, [])
      assert.ok(
        [...result.graph.operations.values()].some(
          (operation) => operation.family === 'invocation' && operation.intrinsicReflection === 'getOwnPropertyDescriptor'
        )
      )
      const item = [...result.projection.classes.values()].find((entry) => entry.name === 'Item')!
      const initializer = item.fields.find((entry) => entry.key === 'detail')?.initializer
      assert.ok(initializer)
      assert.ok(
        result.irBodies?.some((body) => body.sourceOwner === initializer),
        `${owner} descriptor with ${key}`
      )
    }
  }
})

test('shadowed and mutated Reflect methods do not acquire intrinsic field authority', () => {
  for (const text of [
    'function local() { const Reflect = { get(value: unknown, key: string) { return 0 } }; return Reflect.get({}, "x") }; local()',
    'Reflect.get = () => 0; Reflect.get({}, "x")',
    'const alias = Reflect; alias.get = () => 0; Reflect.get({}, "x")',
    'Object.defineProperty(Reflect, "get", { value: () => 0 }); Reflect.get({}, "x")',
    'Reflect.getOwnPropertyDescriptor = () => undefined; Reflect.getOwnPropertyDescriptor({}, "detail")',
    'Object.getOwnPropertyDescriptor = () => undefined; Object.getOwnPropertyDescriptor({}, "detail")'
  ]) {
    const result = compileText(text)
    assert.equal(
      [...result.graph.operations.values()].some((operation) => operation.family === 'invocation' && operation.intrinsicReflection),
      false,
      text
    )
  }
})
