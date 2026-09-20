import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

const compileText = (text: string) => {
  const file = resolve('test/runtime/object-prototype-tag.runtime.js')
  return compile({ rootFileNames: [file], projectFileName: 'test/runtime/tsconfig.json', sourceOverlay: new Map([[file, text]]) })
}
const tagCount = (result: ReturnType<typeof compile>) =>
  [...result.graph.operations.values()].filter((operation) => operation.family === 'computation' && operation.operator === 'ObjectTag')
    .length

test('authenticated Object tags use native operands and string results', () => {
  const result = compileText('console.log(Object.prototype.toString.call([1]), Object.prototype.toString.call(function f() {}))')
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.deepEqual(result.emissionRefusals, [])
  assert.equal(tagCount(result), 2)
  assert.match(result.source!, /gea::objectTag\(/)
  assert.doesNotMatch(result.source!, /Value::box/)
})

test('shadowed and overwritten builtins cannot acquire ObjectTag authority', () => {
  for (const text of [
    'function local() { const Object = { prototype: { toString() { return "custom" } } }; console.log(Object.prototype.toString.call([])) }; local()',
    'Object.prototype.toString = function () { return "custom" }; console.log(Object.prototype.toString.call([]))',
    'Function.prototype.call = function () { return "custom" }; console.log(Object.prototype.toString.call([]))',
    'const prototype = Function.prototype; prototype.call = function () { return "custom" }; console.log(Object.prototype.toString.call([]))'
  ])
    assert.equal(tagCount(compileText(text)), 0, text)
})

test('primitive tags require intact wrapper prototypes', () => {
  for (const text of [
    'Number.prototype[Symbol.toStringTag] = "Custom"; console.log(Object.prototype.toString.call(1))',
    'const wrapper = String.prototype; wrapper[Symbol.toStringTag] = "Custom"; console.log(Object.prototype.toString.call("x"))'
  ])
    assert.equal(tagCount(compileText(text)), 0, text)
})
