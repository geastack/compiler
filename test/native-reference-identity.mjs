import assert from 'node:assert/strict'
import { hasReferenceIdentity } from '../dist/representation/collections.js'
import { representationKey } from '../dist/representation/model.js'
const native = { kind: 'native-handle', protocol: 'Test', version: 1, native: 'TypedCarrier' }
assert.equal(hasReferenceIdentity(native), false)
assert.equal(hasReferenceIdentity({ ...native, referenceIdentity: false }), false)
assert.equal(hasReferenceIdentity({ ...native, referenceIdentity: true }), true)
assert.equal(hasReferenceIdentity({ ...native, native: null, referenceIdentity: true }), false)
assert.notEqual(representationKey(native), representationKey({ ...native, referenceIdentity: true }))
assert.equal(
  hasReferenceIdentity({ kind: 'tagged-union', arms: [{ value: { ...native, referenceIdentity: true } }, { value: native }] }),
  false
)
console.log('native reference identity explicit-contract tests passed')

const { strictEqualityText } = await import('../dist/targets/cpp/emit-equality.js')
const owned = { ...native, referenceIdentity: true }
const operand = (representation, text) => ({ representation, text })
const left = operand(owned, 'left'),
  right = operand(owned, 'right')
const identity = 'gea::weakCollectionIdentity(left) == gea::weakCollectionIdentity(right)'
assert.equal(strictEqualityText('===', left, right), identity)
assert.equal(strictEqualityText('!==', left, right), `!(${identity})`)
assert.equal(strictEqualityText('===', operand(native, 'left'), operand(native, 'right')), null)
assert.equal(strictEqualityText('===', left, operand({ ...owned, native: 'OtherCarrier' }, 'right')), null)
assert.equal(strictEqualityText('===', left, operand({ ...owned, referenceIdentity: false }, 'right')), null)
assert.equal(strictEqualityText('==', left, right), null)
const optional = { kind: 'optional', payload: owned, absence: 'null' }
assert.ok(strictEqualityText('===', operand(optional, 'maybe'), right).includes('gea::weakCollectionIdentity((*maybe))'))
console.log('native strict identity bare and optional carriers passed')
