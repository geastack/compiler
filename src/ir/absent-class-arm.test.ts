import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { allOperationsOf, type GetOperation } from './model.js'

const entry = resolve('test/fixtures/union-absent-class-arm.js')

const unionReadsIn = (name: string): readonly GetOperation[] => {
  const result = compile({ rootFileNames: [entry], projectFileName: null, includeIr: true })
  // The field census declines the disagreeing write set; the stated union governs the slot.
  assert.deepEqual(
    result.refusals.filter((refusal) => refusal.stage !== 'census'),
    []
  )
  assert.ok(result.source !== null)
  assert.doesNotMatch(result.source, /nativeDynamicGet|gea::Value::box/)
  return (result.irBodies ?? [])
    .filter((body) => body.functionName === name)
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => allOperationsOf(block)))
    .flatMap((operation) => (operation.kind === 'get' && operation.receiver.representation.kind === 'tagged-union' ? [operation] : []))
}

test('a union read of a key only the texture family declares answers the Color arm without a dynamic protocol', () => {
  const reads = unionReadsIn('usesCubeUV')
  assert.ok(reads.length >= 2, `expected the isCubeTexture and mapping reads, saw ${reads.length}`)
  for (const read of reads) assert.ok((read.absentClassArms ?? []).length > 0, 'the Color arm is proven absent')
})
