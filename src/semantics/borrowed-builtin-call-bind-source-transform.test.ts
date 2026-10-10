import assert from 'node:assert/strict'
import { test } from 'node:test'
import { borrowedBuiltinCallBindSourceTransform as transform } from './borrowed-builtin-call-bind-source-transform.js'
import { borrowedBuiltinCallBindSourceTransformWithProtocols } from './borrowed-builtin-call-bind-source-transform.js'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'

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

test('JavaScript borrowed own queries retain their algorithm across receiver overrides', () => {
  for (const member of ['hasOwnProperty', 'propertyIsEnumerable']) {
    const source = `var query = Function.prototype.call.bind(Object.prototype.${member});
      var owner = { kept: 1, ${member}() { throw new Error('own override entered') } };
      query(owner, 'kept')`
    const output = borrowedBuiltinCallBindSourceTransformWithProtocols({ fileName: 'own.js', text: source })
    assert.ok(output)
    assert.equal(output.protocolVersion, 1)
    assert.equal(runInNewContext(source), true)
    assert.equal(runInNewContext(output.text), true)
    assert.doesNotMatch(output.text, new RegExp(`owner\\.${member}\\(`))
    assert.doesNotMatch(output.text, / as \{\}/)
    assert.deepEqual(output.protocols, [
      { intrinsic: 'Object', member: member === 'hasOwnProperty' ? 'hasOwn' : 'getOwnPropertyDescriptor' },
      { intrinsic: 'Object', prototypeKeys: [member] },
      { intrinsic: 'Function', prototypeKeys: ['call', 'bind'] },
      { intrinsic: 'Object', callablePrototypeMember: member, ownKeys: ['call'] },
      { intrinsic: 'Function', callablePrototypeMember: 'call', ownKeys: ['bind'] }
    ])
  }
})

test('own-query replacement preserves each evaluated argument and its order', () => {
  const source = `var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
    var effects = [];
    function receiver() { effects.push('receiver'); return { kept: 1 } }
    function key() { effects.push('key'); return 'kept' }
    function extra() { effects.push('extra'); return 7 }
    query(receiver(), key(), extra()); effects.join(',')`
  const output = borrowedBuiltinCallBindSourceTransformWithProtocols({ fileName: 'own.js', text: source })
  assert.ok(output)
  assert.equal(runInNewContext(output.text), 'receiver,key,extra')
})

test('shadowed or published borrowed own queries retain the original capture instead of neutralizing it', () => {
  for (const source of [
    'var Object = foreign; Object.prototype.hasOwnProperty.call(value, key)',
    'var Function = foreign; var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty); query(value, key)',
    'var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty); publish(query)',
    'var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty); query(...values)',
    'var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty); query()'
  ])
    assert.equal(borrowedBuiltinCallBindSourceTransformWithProtocols({ fileName: 'own.js', text: source }), null, source)
})

test('the final compiler ledger discharges replacement and original captured own-query protocols', () => {
  const entry = resolve('test/runtime/borrowed-own-query-protocol.runtime.js')
  const source = `var query = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
    var owner = { kept: 1, hasOwnProperty() { return false } };
    console.log(query(owner, 'kept'))`
  const compileSource = (prefix: string) =>
    compile({
      rootFileNames: [entry],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true,
      sourceOverlay: new Map([[entry, `// @ts-nocheck\n${prefix}\n${source}`]])
    })
  const intact = compileSource('')
  assert.notEqual(intact.source, null, JSON.stringify(intact.refusals))
  for (const mutation of [
    'Object.hasOwn = () => false',
    'Object.prototype.hasOwnProperty = () => false',
    'Function.prototype.call = () => false',
    'Function.prototype.bind = () => () => false',
    'const alias = Object.prototype; alias.hasOwnProperty = () => false',
    'Function.prototype.call.bind = () => () => false',
    'Object.prototype.hasOwnProperty.call = () => false'
  ]) {
    const result = compileSource(mutation)
    assert.equal(result.source, null, mutation)
    assert.equal(
      result.diagnostics.diagnostics.some((one) => one.id.startsWith('intrinsic-protocol/')),
      true,
      `${mutation}: removed source reads remain mandatory final-ledger obligations`
    )
  }
})
