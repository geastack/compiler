import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { IrBody, IrOperation } from './model.js'
import type { CallableAbi } from '../representation/model.js'
import { createUnobservedCallableInputs } from './unobserved-callable-inputs.js'

// The shape of three's WebGLBackground: a function stored into a typed method
// slot, run behind an adapter converting the typed renderer to `any`.
const prelude = `
interface Item { id: number; z: number }
class List {
  opaque: Item[] = []
  push(id: number, z: number): void { this.opaque.push({ id, z }) }
}
class Renderer { list = new List(); frames = 0 }
class Mesh {
  matrix = 1
  onBeforeRender(renderer: Renderer, scene: any, camera: any): void {}
}
const renderer = new Renderer()
renderer.list.push(1, 2)
const mesh = new Mesh()
`

const adapterPromotions = (installer: string): number => {
  const entry = resolve('test/runtime/unobserved-callable-inputs.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([
      [entry, `export {}\n${prelude}\n${installer}\nmesh.onBeforeRender(renderer, null, { matrix: 7 })\nconsole.log(mesh.matrix)\n`]
    ])
  })
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  let count = 0
  for (const demand of result.reflection?.byRepresentation.values() ?? [])
    if (demand.level === 'full' && [...demand.reasons].some((reason) => reason.startsWith('callable-adapter-input'))) count++
  return count
}

test('an adapter input the stored function never names publishes nothing', () => {
  assert.equal(
    adapterPromotions(
      `mesh.onBeforeRender = function (this: Mesh, renderer: any, scene: any, camera: any) { this.matrix = camera.matrix }`
    ),
    0
  )
})

test('target inputs past the stored function declared parameters publish nothing', () => {
  assert.equal(adapterPromotions(`mesh.onBeforeRender = function (this: Mesh) { this.matrix = 3 }`), 0)
})

test('an adapter input the stored function reads dynamically is still published', () => {
  assert.ok(
    adapterPromotions(`mesh.onBeforeRender = function (this: Mesh, renderer: any) { this.matrix = Number(renderer.list.opaque[0].id) }`) > 0
  )
})

test('an adapter input a nested closure captures is still published', () => {
  assert.ok(
    adapterPromotions(
      `let later: () => number = () => 0\nmesh.onBeforeRender = function (renderer: any) { later = () => Number(renderer.frames) }\nconsole.log(later())`
    ) > 0
  )
})

test('an adapter input handed to another function is still published', () => {
  assert.ok(
    adapterPromotions(
      `function framesOf(target: any): number { return Number(target.frames) }\nmesh.onBeforeRender = function (this: Mesh, renderer: any) { this.matrix = framesOf(renderer) }`
    ) > 0
  )
})

// Hand-built: the frames the proof must refuse whatever the body does.
const lineage = 'test' as never
const dynamic = { kind: 'dynamic', reason: 'declared-any-never-narrowed' } as const
const abiOf = (count: number, extra: Partial<CallableAbi> = {}): CallableAbi => ({
  parameters: Array.from({ length: count }, () => ({ value: dynamic }) as never),
  result: { kind: 'void' } as never,
  receiver: null,
  restFrom: null,
  ...extra
})
const bodyOf = (owner: string, operations: IrOperation[], abi: CallableAbi | null, extra: Partial<IrBody> = {}): IrBody =>
  ({
    owner: `body|${owner}` as never,
    sourceOwner: owner as never,
    abi,
    construct: null,
    entry: 'b0' as never,
    blocks: new Map([['b0' as never, { id: 'b0', operations, terminator: { kind: 'return', lineage, value: null } } as never]]),
    blockOrder: ['b0' as never],
    values: new Map(),
    tryRegions: [],
    ...extra
  }) as IrBody

const installerFor = (calleeAbi: CallableAbi, calleeExtra: Partial<IrBody> = {}, calleeOperations?: IrOperation[]) => {
  const allocate = {
    kind: 'allocate-callable',
    lineage,
    functionId: 'fn|callee',
    captures: [],
    result: { id: 'callable', representation: dynamic }
  } as unknown as IrOperation
  const installer = bodyOf('region|installer', [allocate], null)
  const parameter = { kind: 'parameter', lineage, ordinal: 0, result: { id: 'p0', representation: dynamic } } as unknown as IrOperation
  const write = {
    kind: 'binding-write',
    lineage,
    declaration: 'decl|p0',
    value: { value: 'p0', representation: dynamic }
  } as unknown as IrOperation
  const callee = bodyOf('fn|callee', calleeOperations ?? [parameter, write], calleeAbi, calleeExtra)
  const index = createUnobservedCallableInputs([installer, callee], (operation) => (operation === allocate ? installer : undefined))
  return (sourceAbi: CallableAbi, targetAbi: CallableAbi) =>
    index.ignoredParametersOf(allocate, { value: 'callable', representation: dynamic } as never, sourceAbi, targetAbi)
}

test('a write-only parameter cell is unobserved', () => {
  const ignored = installerFor(abiOf(1))(abiOf(1), abiOf(3))
  assert.ok(ignored !== null)
  assert.deepEqual([0, 1, 2].map(ignored), [true, true, true])
})

test('a parameter cell any operation reads is observed', () => {
  const parameter = { kind: 'parameter', lineage, ordinal: 0, result: { id: 'p0', representation: dynamic } } as unknown as IrOperation
  const write = {
    kind: 'binding-write',
    lineage,
    declaration: 'decl|p0',
    value: { value: 'p0', representation: dynamic }
  } as unknown as IrOperation
  const read = {
    kind: 'binding-read',
    lineage,
    declaration: 'decl|p0',
    result: { id: 'r0', representation: dynamic }
  } as unknown as IrOperation
  const ignored = installerFor(abiOf(1), {}, [parameter, write, read])(abiOf(1), abiOf(2))
  assert.ok(ignored !== null)
  assert.deepEqual([0, 1].map(ignored), [false, true])
})

test('an arguments object, a rest frame or a generator body proves nothing', () => {
  assert.equal(installerFor(abiOf(1, { argumentsFrame: 'actual' }))(abiOf(1), abiOf(2)), null)
  assert.equal(installerFor(abiOf(1))(abiOf(1, { argumentsFrame: 'actual' }), abiOf(2)), null)
  assert.equal(installerFor(abiOf(1, { restFrom: 0 }))(abiOf(1, { restFrom: 0 }), abiOf(2)), null)
  assert.equal(installerFor(abiOf(1), { generator: true })(abiOf(1), abiOf(2)), null)
  assert.equal(installerFor(abiOf(2))(abiOf(1), abiOf(2)), null, 'a body of another frame')
})
