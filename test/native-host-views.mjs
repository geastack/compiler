import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createConversionNodes } from '../dist/conversion/nodes.js'
import { createCppConversionRegistry } from '../dist/targets/cpp/conversions.js'
import { beginUnionAliasing, endUnionAliasing } from '../dist/targets/cpp/types.js'
import { conversionRecipeOf, convertedValueText } from '../dist/targets/cpp/emit-narrowing.js'

const handle = (native, viewsFrom = new Map()) => ({
  kind: 'native-handle',
  protocol: native,
  version: 1,
  native,
  bases: [],
  viewsFrom,
  call: null,
  construct: null
})

test('host views require an explicit pair and preserve source identity with one evaluation', () => {
  const source = handle('Node')
  const target = handle('Video', new Map([['Node', 'Video({value})']]))
  const registry = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const capability = registry.nodeFor(source, target).capability
  assert.equal(capability.kind, 'static')
  assert.equal(capability.materializer.allocates, true)
  assert.equal(conversionRecipeOf(source, target)?.id, 'native-handle-view')
  assert.equal(registry.nodeFor(handle('Other'), target).capability.kind, 'never')
  assert.equal(registry.nodeFor(target, source).capability.kind, 'never')
  const expression = convertedValueText(source, target, 'nextNode()')
  const program = `
#include <cassert>
struct Node { int id; };
struct Video { int id; explicit Video(Node node): id(node.id) {} };
int reads = 0;
Node nextNode() { ++reads; return {42}; }
int main() { auto video = ${expression}; assert(video.id == 42 && reads == 1); }
`
  const binary = resolve('dist/native-host-views-test')
  execFileSync('clang++', ['-std=c++20', '-x', 'c++', '-', '-o', binary], { input: program })
  execFileSync(binary)
})

test('conversion capability probes do not emit dynamic helper functions', () => {
  const source = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  // An OWNED record: a shared one is a live structural view whose field plan
  // only the conversion graph selects, so its context-free text renders nothing.
  const target = {
    kind: 'record',
    shapeId: 'probe-record',
    ownership: 'owned',
    accessors: [],
    fields: [{ key: 'name', required: true, value: { kind: 'string' } }]
  }
  beginUnionAliasing()
  try {
    assert.equal(conversionRecipeOf(source, target)?.renders, true)
  } finally {
    assert.equal(endUnionAliasing().functions.length, 0)
  }
  beginUnionAliasing()
  try {
    assert.ok(convertedValueText(source, target, 'actualInput'))
  } finally {
    assert.ok(endUnionAliasing().functions.length > 0, 'real conversions still publish helpers')
  }
})
