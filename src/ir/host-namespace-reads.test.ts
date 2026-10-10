import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrValueId } from '../identity/ids.js'
import { hostNamespaceCensusMatches, hostNamespaceReadsOf, type HostNamespaceCensus } from './host-namespace-reads.js'
import type { IrBody, IrNonTerminatorOperation } from './model.js'
import type { HostSpellings } from '../targets/cpp/host/host-members.js'

const root = 'root' as IrValueId
const value = 'value' as IrValueId
const method = 'method' as IrValueId
const expected: HostNamespaceCensus = {
  reads: new Map([[root, 'Host']]),
  values: new Map([[value, 'Host.instance']]),
  functionReads: new Map([[method, { kind: 'path', text: 'native::inspect', arguments: 'dynamic', result: 'dynamic' }]]),
  definitelyPresent: new Set([root, value])
}

test('host census authentication compares selected row contracts rather than map or row identity', () => {
  const actual: HostNamespaceCensus = {
    reads: new Map(expected.reads),
    values: new Map(expected.values),
    functionReads: new Map([[method, { kind: 'path', text: 'native::inspect', arguments: 'dynamic', result: 'dynamic' }]]),
    definitelyPresent: new Set(expected.definitelyPresent)
  }
  assert.equal(hostNamespaceCensusMatches(expected, actual), true)
  assert.equal(hostNamespaceCensusMatches(expected, undefined), false)
})

test('changing the host argument boundary or call identity invalidates the publication', () => {
  for (const row of [
    { kind: 'path', text: 'native::inspect', result: 'dynamic' },
    { kind: 'path', text: 'native::inspect', arguments: 'dynamic' },
    { kind: 'path', text: 'native::other', arguments: 'dynamic', result: 'dynamic' },
    { kind: 'template', emit: 'native::inspect', arguments: 'dynamic', result: 'dynamic' }
  ] as const) {
    assert.equal(hostNamespaceCensusMatches(expected, { ...expected, functionReads: new Map([[method, row]]) }), false)
  }
  assert.equal(hostNamespaceCensusMatches(expected, { ...expected, reads: new Map([[root, 'Other']]) }), false)
  assert.equal(hostNamespaceCensusMatches(expected, { ...expected, values: new Map() }), false)
  assert.equal(hostNamespaceCensusMatches(expected, { ...expected, functionReads: new Map() }), false)
  assert.equal(hostNamespaceCensusMatches(expected, { ...expected, definitelyPresent: new Set([root]) }), false)
})

test('an installed path merged with an arbitrary absent branch is not definitely present', () => {
  const entry = 'presence-entry' as never
  const lineage = 'presence-source' as never
  const carrier = { kind: 'undefined' } as const
  const operand = (id: string) => ({ value: id as never, representation: carrier })
  const result = (id: string) => ({ id: id as never, representation: carrier })
  const operations: IrNonTerminatorOperation[] = [
    { kind: 'binding-read', lineage, declaration: 'installed' as never, result: result('installed-read') },
    { kind: 'constant', lineage, literal: 'undefined', text: 'undefined', result: result('absent') },
    { kind: 'convert', lineage, conversionUse: 'presence-convert', source: operand('installed-read'), result: result('converted') },
    {
      kind: 'phi',
      lineage,
      incoming: [
        { block: entry, value: operand('converted') },
        { block: entry, value: operand('absent') }
      ],
      result: result('maybe-installed')
    },
    {
      kind: 'phi',
      lineage,
      incoming: [
        { block: entry, value: operand('installed-read') },
        { block: entry, value: operand('converted') }
      ],
      result: result('always-installed')
    }
  ]
  const body = {
    owner: 'presence-owner' as never,
    sourceOwner: 'presence-owner' as never,
    abi: null,
    construct: null,
    entry,
    blockOrder: [entry],
    values: new Map(),
    tryRegions: [],
    blocks: new Map([[entry, { id: entry, operations, terminator: { kind: 'return', lineage: null, value: null } }]])
  } as IrBody
  const hosts = {
    namespaces: { roots: new Set(['Installed']), methods: new Map(), properties: new Map(), typeofs: new Map() }
  } as unknown as HostSpellings
  const census = hostNamespaceReadsOf(
    body,
    new Map([['installed' as never, { storage: { kind: 'host-namespace', linkageName: 'Installed' }, representation: carrier }]]),
    hosts,
    new Map()
  )
  assert.equal(census.reads.get('maybe-installed' as never), 'Installed')
  assert.equal(census.definitelyPresent.has('installed-read' as never), true)
  assert.equal(census.definitelyPresent.has('converted' as never), true)
  assert.equal(census.definitelyPresent.has('always-installed' as never), true)
  assert.equal(census.definitelyPresent.has('maybe-installed' as never), false)
})
