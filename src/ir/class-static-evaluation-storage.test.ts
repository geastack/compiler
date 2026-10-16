import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
for (const layout of ['single', 'per-file'] as const)
  for (const name of ['class-static-block-capture-identity.runtime.ts', 'class-static-evaluation-own-fields.runtime.ts'])
    test(`static properties retain evaluated constructor storage ${layout}: ${name}`, () => {
      const result = compile({
        rootFileNames: [resolve('test/runtime', name)],
        projectFileName: null,
        includeIr: true,
        translationUnits: layout
      })
      assert.ok(result.certificate && result.units.length > 0, JSON.stringify(result.refusals))
      const source = result.units.map((unit) => unit.source).join('\n')
      assert.ok(source.includes('constructorStaticViewHolder'))
      assert.ok(source.includes('gea_static->present = true'))
      assert.ok(/struct gea_static_field_\w+_view final/.test(source))
      if (name === 'class-static-evaluation-own-fields.runtime.ts')
        assert.equal(
          (source.match(/struct gea_static_field_\w+_view final/g) ?? []).length,
          3,
          'inherited fields share typed tags; unrelated and differently typed roots stay separate'
        )
      assert.ok(!/^gea::(?:Function|Optional).*gea_static_field_.*;/m.test(source))
    })
test('static own-field views refuse an inherited accessor barrier', () => {
  const entry = resolve('test/fixtures/static-storage-accessor-barrier.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        entry,
        `class Base{static value=7} class Mid extends Base{static get value(){return 12}} class Derived extends Mid{static other=this.read();static read(){return this.value}static value=9} console.log(Derived.other)`
      ]
    ])
  })
  assert.ok(
    result.source === null,
    JSON.stringify(
      [...result.projection.classes].map(([id, c]) => ({
        id,
        base: c.base,
        fields: c.staticFields.map((x) => x.key),
        accessors: c.staticAccessors.map((x) => x.key)
      }))
    )
  )
  assert.ok(
    result.refusals.some((refusal) => refusal.reason.includes('inherited static method/accessor barrier')),
    JSON.stringify({ refusals: result.refusals, diagnostics: result.diagnostics })
  )
})

for (const expression of ['Object.keys(C)', "Object.hasOwn(C,'value')", 'Reflect.ownKeys(C)', 'delete (C as any).value'])
  test(`static reflection stays explicitly unsupported: ${expression}`, () => {
    const entry = resolve('test/fixtures/static-storage-reflection.ts')
    const result = compile({
      rootFileNames: [entry],
      projectFileName: null,
      sourceOverlay: new Map([[entry, `class C{static value=1} console.log(${expression})`]])
    })
    assert.equal(result.source, null, expression)
  })
