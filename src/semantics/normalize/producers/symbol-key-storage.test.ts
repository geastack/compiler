import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

for (const member of ['[key] = 2', 'get [key]() { return 2 }']) {
  test(`inherited unretained symbol identity refuses own-key enumeration: ${member}`, () => {
    const entry = resolve('test/runtime/native-symbol-property-identity.runtime.ts')
    const result = compile({
      rootFileNames: [entry],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          entry,
          `const key = Symbol('key'); class Base { ${member} }; class Child extends Base {} console.log(Reflect.ownKeys(new Child()).length);`
        ]
      ])
    })
    assert.ok(result.certificate, 'the input must reach native emission')
    assert.ok(result.emissionRefusals.some((refusal) => JSON.stringify(refusal).includes('no retained runtime identity')))
  })
}

test('symbol data storage cannot erase a neighboring string accessor', () => {
  const entry = resolve('test/runtime/native-symbol-property-identity.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        entry,
        `const key = Symbol('key'); const object = { get value() { return 7 }, [key]: 1 }; console.log(object.value, Reflect.ownKeys(object).length);`
      ]
    ])
  })
  assert.equal(result.certificate, null)
  assert.ok(result.diagnostics.diagnostics.some((entry) => entry.message.includes('preserves both index storage and accessor descriptors')))
})
