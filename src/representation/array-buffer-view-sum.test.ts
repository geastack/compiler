import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'

const entry = resolve('test/runtime/typed-array-into-lib-array-buffer-view-slot.runtime.ts')

const compileSource = (source: string) =>
  compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]) })

// A host member whose C++ overloads take each view separately cannot take the
// sum `ArrayBufferView` derives as. Handing it the `TaggedUnion` would surface
// as a template error in clang; the printer must refuse it by name instead.
test('an ArrayBufferView sum passed through to a host member is refused by name', () => {
  const result = compileSource(`
    const views: ArrayBufferView[] = [new TextEncoder().encode('hi'), new DataView(new ArrayBuffer(2))]
    const view: ArrayBufferView = views[0]!
    console.log(new TextDecoder().decode(view))
  `)
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.ok(
    result.emissionRefusals.some((refusal) => refusal.key === 'host-invocation:pass-through-view-sum'),
    JSON.stringify(result.emissionRefusals)
  )
})

test('lib ArrayBufferView derives no record of its own', () => {
  const result = compileSource(`
    function windowOf(view: ArrayBufferView): number { return view.byteLength }
    const views: ArrayBufferView[] = [new Uint8Array(3), new DataView(new ArrayBuffer(5))]
    for (const view of views) console.log(windowOf(view))
  `)
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.deepEqual(result.emissionRefusals, [])
  assert.doesNotMatch(result.source ?? '', /struct\s+\w*ArrayBufferView/)
})
