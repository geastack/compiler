import assert from 'node:assert/strict'
import test from 'node:test'
import { thisConstructorSourceTransform } from './this-constructor-source-transform.js'

test('the cast states exactly the frame the `new this.constructor(...)` site supplies', () => {
  const text = [
    'class A {',
    '  clone() { return new this.constructor().copy(this) }',
    '  pair(x) { return new this.constructor(x, 2) }',
    '  spread(xs) { return new this.constructor(...xs) }',
    '}'
  ].join('\n')
  const rewritten = thisConstructorSourceTransform({ fileName: 'a.js', text })
  assert.ok(rewritten)
  // No argument supplied: no frame slot through which a candidate could be
  // handed a dynamic value; every candidate parameter is omitted.
  assert.ok(rewritten.includes('new (/** @type {new () => this} */ (this.constructor))()'))
  assert.ok(rewritten.includes('new (/** @type {new (arg0: any, arg1: any) => this} */ (this.constructor))(x, 2)'))
  // A spread's count is not a syntactic fact: the rest frame remains.
  assert.ok(rewritten.includes('new (/** @type {new (...args: any[]) => this} */ (this.constructor))(...xs)'))
  const typed = thisConstructorSourceTransform({ fileName: 'a.ts', text: 'class B { clone() { return new this.constructor() } }' })
  assert.ok(typed?.includes('new (this.constructor as new () => this)()'))
})
