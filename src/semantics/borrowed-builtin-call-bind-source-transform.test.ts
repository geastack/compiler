import assert from 'node:assert/strict'
import { test } from 'node:test'
import { borrowedBuiltinCallBindSourceTransform as transform } from './borrowed-builtin-call-bind-source-transform.js'

test('Object tag calls retain the builtin and all argument evaluations', () => {
  const text = 'Object.prototype.toString.call(null, effect()); Object.prototype.toString.call([1]);'
  assert.equal(transform({ fileName: 'tags.js', text }), null)
})

test('bound Object tag calls retain the builtin, including an absent receiver', () => {
  const text = 'var tag = Function.prototype.call.bind(Object.prototype.toString); tag([1]); tag();'
  const actual = transform({ fileName: 'tags.js', text })
  assert.match(actual!, /Object\.prototype\.toString\.call\(\[1\]\)/)
  assert.match(actual!, /Object\.prototype\.toString\.call\(\)/)
  assert.doesNotMatch(actual!, /\[1\]\.toString/)
})

test('a shadowed Function cannot authenticate a bound builtin by spelling', () => {
  const text = 'function local(Function) { var tag = Function.prototype.call.bind(Object.prototype.toString); tag([]) }'
  assert.equal(transform({ fileName: 'tags.js', text }), null)
})

test('mutated call or bind keeps the original captured builtin expression', () => {
  for (const mutation of [
    'Function.prototype.bind = custom;',
    'const alias = Function.prototype; alias.call = custom;',
    'Object.defineProperty(Function.prototype, "bind", descriptor);'
  ]) {
    const text = `${mutation} var tag = Function.prototype.call.bind(Object.prototype.toString); tag([])`
    assert.equal(transform({ fileName: 'tags.js', text }), null)
  }
})

test('a typed-array construction as the borrowed receiver goes through Array.from, keeping Array typing', () => {
  const text = "Array.prototype.map.call(new Uint8Array(buffer), (x) => ('00' + x.toString(16)).slice(-2)).join('')"
  const actual = transform({ fileName: 'hex.ts', text })
  assert.equal(actual, "Array.from(new Uint8Array(buffer)).map((x) => ('00' + x.toString(16)).slice(-2)).join('')")
})

test('a plain-array construction as the borrowed receiver keeps the direct member call', () => {
  const text = 'Array.prototype.join.call(new Array(3), "-")'
  assert.equal(transform({ fileName: 'join.ts', text }), 'new Array(3).join("-")')
})
