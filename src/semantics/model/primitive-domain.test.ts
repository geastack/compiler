import assert from 'node:assert/strict'
import test from 'node:test'
import { declarationId } from '../../identity/ids.js'
import { primitiveDomainOf, sharedPrimitiveDomainOf } from './primitive-domain.js'
import { createStructuralTypeTable } from './structural-type-table.js'

test('unique symbol values share the symbol primitive domain', () => {
  const table = createStructuralTypeTable()
  const unique = table.intern({ kind: 'unique-symbol', declaration: declarationId('symbol-domain', 0) })
  const symbol = table.intern({ kind: 'primitive', primitive: 'symbol' })
  assert.equal(primitiveDomainOf(table.get(unique).shape), 'symbol')
  assert.equal(
    sharedPrimitiveDomainOf((id) => table.get(id).shape, { kind: 'union', members: [unique, symbol] }),
    'symbol'
  )
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  assert.equal(
    sharedPrimitiveDomainOf((id) => table.get(id).shape, { kind: 'union', members: [unique, string] }),
    null
  )
})
