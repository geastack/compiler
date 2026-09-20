import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { runFrontend, type FrontendResult } from './frontend.js'
import { nodeOfOperation, type StructuralTypeId } from '../identity/ids.js'
import { installedProducers } from './normalize/producers/installed.js'

/**
 * Whether a slot holds an instance of a class this program constructed --
 * through a union if the slot is one.
 *
 * A JS dictionary starts empty (`this.staticChildren = {}`), so the value it
 * holds is `undefined | Node`, and that is true of every such cache. Demanding
 * a BARE `class-instance` here would assert that the cache can never miss,
 * which is a different claim than the one this test makes: that the cache
 * closes through the identity of the class that writes it.
 */
const holdsClassInstance = (id: StructuralTypeId, graph: FrontendResult['graph'], seen = new Set<StructuralTypeId>()): boolean => {
  if (seen.has(id)) return false
  seen.add(id)
  const structural = graph.structuralTypes.get(id)
  if (!structural) return false
  if (structural.shape.kind === 'class-instance') return true
  return (
    structural.shape.kind === 'union' &&
    structural.shape.members.some((member: StructuralTypeId) => holdsClassInstance(member, graph, seen))
  )
}

test('a computed JS child cache closes through the constructed class identity', () => {
  // find-my-way's router node, through this package's own devDependency.
  const fixture = createRequire(import.meta.url).resolve('find-my-way/lib/node.js')
  const result = runFrontend({
    rootFileNames: [fixture],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    javaScriptSources: true,
    dynamicFallback: true,
    producers: installedProducers(() => [])
  })

  const staticChildren = [...result.graph.operations.values()].filter((operation) => {
    const location = result.locationOfNode(nodeOfOperation(operation.id))
    return location !== null && resolve(location.file) === resolve(fixture) && location.line >= 34 && location.line <= 77
  })
  assert.ok(staticChildren.length > 0)
  let closesThroughClass = false
  for (const operation of staticChildren) {
    for (const output of operation.results) {
      const structural = result.graph.structuralTypes.get(output.type)
      assert.ok(structural)
      assert.notEqual(structural.shape.kind, 'unresolved')
      if (structural.shape.kind !== 'object') continue
      closesThroughClass ||= structural.shape.index.some((index) => holdsClassInstance(index.value, result.graph))
    }
  }
  assert.ok(closesThroughClass)
})
