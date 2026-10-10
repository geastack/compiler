import assert from 'node:assert/strict'
import test from 'node:test'
import { createFreshIndexedStorageAuthority, type FreshIndexedStorageInput } from './fresh-indexed-storage.js'

type Value = 'string' | 'string-array' | 'number'
const fixture = (patch: Partial<FreshIndexedStorageInput<string, Value>> = {}): FreshIndexedStorageInput<string, Value> => ({
  origins: [{ node: 'literal', entries: [] }],
  aliases: [
    { from: 'literal', to: 'owner' },
    { from: 'owner', to: 'query-parameter' },
    { from: 'query-parameter', to: 'query-dictionary-return' },
    { from: 'query-dictionary-return', to: 'call-dictionary-result' },
    { from: 'call-dictionary-result', to: 'alias-owner' }
  ],
  writes: [
    { node: 'owner', value: 'string' },
    { node: 'alias-owner', value: 'string-array' },
    { node: 'owner', value: 'string' }
  ],
  inputs: [{ node: 'query-parameter', origin: 'literal' }],
  blocked: [],
  ...patch
})

test('fresh storage receives every write through bindings and exact dictionary return channels', () => {
  const authority = createFreshIndexedStorageAuthority(fixture())
  const component = authority.componentOf('literal')
  assert.ok(component)
  assert.deepEqual(component.origins, ['literal'])
  assert.deepEqual(component.values, ['string', 'string-array'])
  for (const node of ['owner', 'query-parameter', 'query-dictionary-return', 'call-dictionary-result', 'alias-owner'])
    assert.equal(authority.componentOf(node), component)
  // Scalar, array and absence return alternatives are separate value channels.
  assert.equal(authority.componentOf('query-string-return'), null)
  assert.equal(authority.componentOf('query-array-return'), null)
  assert.equal(authority.componentOf('query-undefined-return'), null)
})

test('the component uses observed entries without introducing unwritten contextual alternatives', () => {
  const input = fixture({ writes: [{ node: 'owner', value: 'string' }] })
  assert.deepEqual(createFreshIndexedStorageAuthority(input).componentOf('owner')?.values, ['string'])
  const empty = fixture({ writes: [] })
  assert.deepEqual(createFreshIndexedStorageAuthority(empty).componentOf('owner')?.values, [])
})

test('distinct fresh allocations sharing one native frame retain their identities and storage writes', () => {
  const input = fixture({
    origins: [
      { node: 'literal', entries: ['string'] },
      { node: 'second-literal', entries: ['number'] }
    ],
    inputs: [
      { node: 'query-parameter', origin: 'literal' },
      { node: 'query-parameter', origin: 'second-literal' }
    ]
  })
  const authority = createFreshIndexedStorageAuthority(input)
  const component = authority.componentOf('literal')
  assert.ok(component)
  assert.deepEqual(component.origins, ['literal', 'second-literal'])
  assert.deepEqual(component.values, ['string', 'number', 'string-array'])
  assert.equal(authority.componentOf('second-literal'), component)
})

test('arbitrary homogeneous dictionary sources never inherit a fresh allocation carrier', () => {
  const input = fixture({
    nodes: ['unrelated-homogeneous-result'],
    inputs: [
      { node: 'query-parameter', origin: 'literal' },
      { node: 'unrelated-homogeneous-result', origin: null }
    ]
  })
  const authority = createFreshIndexedStorageAuthority(input)
  assert.ok(authority.componentOf('literal'))
  assert.equal(authority.componentOf('unrelated-homogeneous-result'), null)
  assert.equal(
    createFreshIndexedStorageAuthority<string, Value>({ origins: [], aliases: [], writes: [], inputs: [], blocked: [] }).componentOf(
      'owner'
    ),
    null
  )
})

test('an open dictionary input or falsely attributed non-fresh origin rejects the whole alias component', () => {
  for (const origin of [null, 'unknown-allocation'] as const) {
    const authority = createFreshIndexedStorageAuthority(fixture({ inputs: [{ node: 'query-parameter', origin }] }))
    for (const node of ['literal', 'owner', 'query-parameter', 'alias-owner']) assert.equal(authority.componentOf(node), null)
  }
})

test('every unaccounted escape, capture, or incompatible alias frame blocks its complete component', () => {
  for (const blocked of ['owner', 'query-parameter', 'query-dictionary-return', 'alias-owner']) {
    const authority = createFreshIndexedStorageAuthority(fixture({ blocked: [blocked] }))
    assert.equal(authority.componentOf('literal'), null)
    assert.equal(authority.componentOf('alias-owner'), null)
  }
})

test('conflicting allocation identities fail closed while unrelated fresh components stay independent', () => {
  const authority = createFreshIndexedStorageAuthority(
    fixture({
      origins: [
        { node: 'literal', entries: [] },
        { node: 'literal', entries: ['number'] },
        { node: 'independent-literal', entries: ['string'] }
      ]
    })
  )
  assert.equal(authority.componentOf('owner'), null)
  assert.deepEqual(authority.componentOf('independent-literal')?.values, ['string'])
})
