import { isRegionId, type DeclarationId, type FunctionId, type IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { representationKey } from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/** One physical async result convention, proved over every surviving use. */
export interface AsyncResultConventions {
  readonly taskBodies: ReadonlySet<FunctionId>
  readonly taskResults: ReadonlySet<IrValueId>
}

/**
 * Closed, capture-free local functions only. The public Promise ABI remains
 * the fallback for an escape, an indirect call, a non-coroutine caller, a
 * retained result, or an adopting return. Never select per call site: one
 * rejected use rejects the entire body, including its otherwise eligible calls.
 */
export const asyncResultConventionsOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  directBindings: ReadonlyMap<DeclarationId, FunctionId>,
  coroutine: (body: IrBody) => boolean,
  captureFree: (owner: FunctionId) => boolean
): AsyncResultConventions => {
  const candidates = new Set<FunctionId>()
  const counts = new Map<FunctionId, number>()
  const resultsByBody = new Map<FunctionId, string>()
  for (const body of bodies) {
    if (isRegionId(body.sourceOwner)) continue
    counts.set(body.sourceOwner, (counts.get(body.sourceOwner) ?? 0) + 1)
    const result = body.abi?.result
    if (!coroutine(body) || !captureFree(body.sourceOwner) || body.construct !== null || body.abi?.receiver !== null) continue
    if (result?.kind !== 'promise') continue
    resultsByBody.set(body.sourceOwner, representationKey(result))
    // Objects may have a thenable protocol. Task settles plain payloads only.
    if (!['scalar', 'string', 'void', 'null', 'undefined', 'bigint'].includes(result.value.kind)) continue
    let exact = true
    for (const block of body.blocks.values()) {
      const returned = block.terminator.kind === 'return' ? block.terminator.value : null
      if (returned && representationKey(returned.representation) !== representationKey(result.value)) exact = false
      for (const operation of block.operations)
        if (operation.kind === 'convert' && operation.source.representation.kind === 'dynamic') exact = false
    }
    if (exact) candidates.add(body.sourceOwner)
  }
  for (const [owner, count] of counts) if (count !== 1) candidates.delete(owner)

  const callableValues = new Map<IrValueId, FunctionId>()
  const bindings = new Map<DeclarationId, FunctionId>()
  const reject = (owner: FunctionId): void => {
    candidates.delete(owner)
  }
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'allocate-callable') callableValues.set(operation.result.id, operation.functionId)
  for (const [declaration, owner] of directBindings) {
    // Region/external cells can be exported through module records. Until
    // that boundary is certified closed, leave their Promise ABI intact.
    if (placements.get(declaration)?.storage.kind === 'local') bindings.set(declaration, owner)
  }
  for (const body of bodies) {
    for (const declaration of body.facts?.capturedDeclarations ?? []) {
      const owner = bindings.get(declaration)
      if (owner !== undefined) reject(owner)
    }
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'binding-read') {
          const owner = bindings.get(operation.declaration)
          if (owner !== undefined) callableValues.set(operation.result.id, owner)
        }
  }

  const calls = new Map<FunctionId, IrValueId[]>()
  for (const body of bodies) {
    const reads = new Map<IrValueId, number>()
    const read = (operation: IrOperation): void => {
      for (const operand of operandsOfIrOperation(operation)) reads.set(operand.value, (reads.get(operand.value) ?? 0) + 1)
    }
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) read(operation)
      read(block.terminator)
    }
    for (const region of body.iteratorCloseRegions ?? []) reads.set(region.iterator.value, (reads.get(region.iterator.value) ?? 0) + 1)
    for (const block of body.blocks.values()) {
      const operations: readonly IrOperation[] = [...block.operations, block.terminator]
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index]!
        for (const operand of operandsOfIrOperation(operation)) {
          const owner = callableValues.get(operand.value)
          if (owner === undefined) continue
          const permitted =
            (operation.kind === 'binding-write' &&
              operation.value.value === operand.value &&
              bindings.get(operation.declaration) === owner) ||
            (operation.kind === 'call' &&
              operation.callee.value === operand.value &&
              operation.target?.kind === 'direct' &&
              operation.target.functionId === owner &&
              operation.arguments.every((argument) => argument.value !== operand.value) &&
              operation.receiver?.value !== operand.value)
          if (!permitted) reject(owner)
        }
        if (operation.kind !== 'call' || operation.target?.kind !== 'direct') continue
        const owner = operation.target.functionId
        const awaited = operations[index + 1]
        const result = operation.result
        if (
          !coroutine(body) ||
          callableValues.get(operation.callee.value) !== owner ||
          operation.builtinShadowGuard !== undefined ||
          result?.representation.kind !== 'promise' ||
          representationKey(result.representation) !== resultsByBody.get(owner) ||
          awaited?.kind !== 'await' ||
          awaited.operand.value !== result.id ||
          reads.get(result.id) !== 1 ||
          representationKey(awaited.operand.representation) !== representationKey(result.representation)
        ) {
          reject(owner)
          continue
        }
        const results = calls.get(owner) ?? []
        results.push(result.id)
        calls.set(owner, results)
      }
    }
  }
  const taskResults = new Set<IrValueId>()
  for (const owner of candidates) {
    const results = calls.get(owner)
    if (!results?.length) {
      candidates.delete(owner)
      continue
    }
    for (const result of results) taskResults.add(result)
  }
  return { taskBodies: candidates, taskResults }
}
