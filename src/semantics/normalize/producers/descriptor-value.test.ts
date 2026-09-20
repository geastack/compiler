import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

for (const owner of ['Object', 'Reflect'])
  test(`${owner} native class descriptors preserve declared value carriers`, () => {
    const file = resolve('test/runtime/native-reflect-class-operations.runtime.ts')
    const result = compile({
      rootFileNames: [file],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          file,
          `class Base { value = 1 }
         class Item extends Base { detail = 2 }
         const item = new Item();
         const own = ${owner}.getOwnPropertyDescriptor(item, 'detail');
         const inherited = ${owner}.getOwnPropertyDescriptor(item, 'value');
         console.log(own?.value, own?.writable, inherited?.value);
         const asserted = ${owner}.getOwnPropertyDescriptor(item, 'detail') as {
           value: number, writable: boolean, enumerable: boolean, configurable: boolean
         };
         console.log(asserted.value, asserted.writable, asserted.enumerable, asserted.configurable);`
        ]
      ])
    })
    assert.ok(result.certificate, JSON.stringify(result.refusals))
    assert.deepEqual(result.emissionRefusals, [])
    assert.ok(result.source)
    assert.ok(!result.source.includes('Value::box'))
  })
