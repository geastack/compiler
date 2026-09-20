import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { IrValueId } from '../identity/ids.js'
import { allOperationsOf, type IrBody } from './model.js'
import { presenceProofsOf } from './presence-proof.js'

const entry = resolve('test/runtime/presence-proof.ts')

const bodiesOf = (source: string): readonly IrBody[] => {
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]), includeIr: true })
  return result.irBodies ?? []
}

/** Every load out of an `optional` carrier the named function's bodies perform. */
const loadsIn = (bodies: readonly IrBody[], name: string): readonly IrValueId[] =>
  bodies
    .filter((body) => body.functionName === name)
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => allOperationsOf(block)))
    .flatMap((operation) =>
      operation.kind === 'convert' &&
      operation.source.representation.kind === 'optional' &&
      operation.result.representation.kind !== 'optional'
        ? [operation.result.id]
        : []
    )

const program = `
let shared: number | undefined = 1
function clear(): void { shared = undefined }
function tested(): number {
  if (shared !== undefined) return shared
  return 0
}
function testedThenCleared(): number {
  if (shared !== undefined) {
    clear()
    return shared
  }
  return 0
}
function bump(x?: number): number {
  if (x !== undefined) return x + 1
  return 0
}
function orFive(x?: number): number {
  return x || 5
}
function reassigned(x?: number): number {
  if (x === undefined) x = 7
  return x
}
function eitherMissing(a?: number, b?: number): number {
  if (a === undefined || b === undefined) return 0
  return a + b
}
function bothPresent(a?: number, b?: number): number {
  if (a !== undefined && b !== undefined) return a * b
  return 0
}
function assignedInCondition(s: string): string {
  let m: RegExpExecArray | null
  if ((m = /x+/.exec(s)) !== null) return m[0]
  return ''
}
console.log(tested(), testedThenCleared(), bump(1), bump(), orFive(), orFive(2), reassigned(), reassigned(3))
console.log(eitherMissing(1, 2), eitherMissing(), bothPresent(2, 3), bothPresent(), assignedInCondition('axx'))
clear()
`

test('a presence test of the loaded cell or value proves the load', () => {
  const bodies = bodiesOf(program)
  const proofs = presenceProofsOf(bodies)
  for (const name of ['tested', 'bump', 'orFive', 'reassigned', 'eitherMissing', 'bothPresent', 'assignedInCondition']) {
    const loads = loadsIn(bodies, name)
    assert.ok(loads.length > 0, `${name} performs a load`)
    for (const load of loads) assert.ok(proofs.has(load), `${name}: ${load} is proven`)
  }
})

const emittedOf = (source: string): string => {
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]) })
  assert.ok(result.certification?.certified, 'certifies')
  return result.units
    .filter((unit) => unit.role !== 'runtime-header')
    .map((unit) => unit.source)
    .join('\n')
}

test('a proven load reads the payload directly; an unproven one tests it first', () => {
  const proven = emittedOf(`
function bump(x?: number): number {
  if (x !== undefined) return x + 1
  return 0
}
console.log(bump(1), bump())
`)
  assert.ok(!proven.includes('presentOrThrow'))
  const unproven = emittedOf(`
let shared: number | undefined = 1
function clear(): void { shared = undefined }
function testedThenCleared(): number {
  if (shared !== undefined) {
    clear()
    return shared
  }
  return 0
}
console.log(testedThenCleared())
`)
  assert.ok(unproven.includes('gea::host::presentOrThrow('))
})

test('a call that can write the cell between the test and the load leaves it unproven', () => {
  // The checker keeps `shared` narrowed across `clear()`; the cell does not.
  const bodies = bodiesOf(program)
  const proofs = presenceProofsOf(bodies)
  const loads = loadsIn(bodies, 'testedThenCleared')
  assert.ok(loads.length > 0)
  assert.ok(loads.some((load) => !proofs.has(load)))
})
