import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'
import { walkRepresentation } from '../../representation/model.js'

/**
 * three's `BufferAttribute.count` (a plain field) and
 * `InterleavedBufferAttribute.count` (`get count() { return this.data.count }`)
 * declare the same key differently on sibling classes. A read of `count`
 * through a receiver typed as their union -- `positionAttribute.count` in
 * `BufferGeometry.setFromPoints` -- is not proof the receiver escapes: only a
 * getter BODY that itself leaks the receiver is
 * (`callable-reach.ts`'s `member-read` arm, via `sourceClassKeyReadPlanOf`'s
 * `readBodies`). Certification (zero boxing) is the compiler's own definition
 * of success, so this compiles the whole program end to end rather than
 * probing the proof's internal boolean directly.
 */
const compileFixture = (getterBody: string, extra = '') => {
  const entry = resolve('test/fixtures/family-getter-member-read.js')
  const source = `
    class Data {
      /** @param {number} count */
      constructor(count) { this.count = count; }
    }
    class BufferAttribute {
      /** @param {number} count */
      constructor(count) { this.count = count; }
    }
    class InterleavedBufferAttribute {
      /** @param {Data} data */
      constructor(data) { this.data = data; }
      get count() { ${getterBody} }
    }
    /** @param {BufferAttribute|InterleavedBufferAttribute} attribute */
    function readCount(attribute) { return attribute.count; }
    ${extra}
    // Avoid \`console.log\` -- its \`any\` parameters box regardless of this
    // fixture, exactly as \`stored-listener-member-closure.test.ts\`'s own
    // full-frontend test avoids it. Accumulate into a typed local instead.
    let total = 0;
    total += readCount(new BufferAttribute(3));
    total += readCount(new InterleavedBufferAttribute(new Data(3)));
    if (total < 0) throw new Error('unreachable');
  `
  return compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/native-method-inferred-parameters.tsconfig.json'),
    javaScriptSources: true,
    // The runtime harness compiles every test as a complete classic script;
    // this compile states the same boundary (`ProgramInput.closedScriptScope`).
    closedScriptScope: true,
    sourceOverlay: new Map([[entry, source]])
  })
}

const boxedCarriers = (result: ReturnType<typeof compileFixture>) =>
  [...result.representations.plan.selected.values()].filter((value) =>
    [...walkRepresentation(value)].some((part) => part.kind === 'dynamic')
  )

test('a primitive field one family member declares as a getter certifies with zero boxing', () => {
  const result = compileFixture('return this.data.count;')
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.deepEqual(boxedCarriers(result), [], 'the getter forwards to a data member and returns a primitive: no carrier should box')
})

test('a getter that leaks its own receiver may not certify with zero boxing', () => {
  const result = compileFixture('globalThis.sink = this; return this.data.count;')
  if (result.certificate)
    assert.notDeepEqual(boxedCarriers(result), [], 'a getter that stores `this` globally must not be treated as inert')
})

test('a reflective defineProperty that could install an accessor under the key may not certify a plain data class with zero boxing', () => {
  const result = compileFixture(
    'return this.data.count;',
    "Object.defineProperty(new BufferAttribute(1), 'count', { get() { return globalThis; } });"
  )
  if (result.certificate)
    assert.notDeepEqual(boxedCarriers(result), [], 'a reflective defineProperty under the same key must refuse the static plan')
})
