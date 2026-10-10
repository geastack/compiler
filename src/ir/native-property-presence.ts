import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeFieldViewIdentityTransportOf } from '../conversion/native-field-view.js'
import { nativeArrayViewIdentityTransportOf } from '../conversion/array-view.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { IrValueId } from '../identity/ids.js'
import { representationKey } from '../representation/model.js'
import { evaluatedResultIdentityOf, identityOperandOf, operandOf, type OperandSource } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { controlFlowGraphOf, dominatorTreeOf } from './dominance.js'
import { implicitSuccessorsOf } from './exception-edges.js'
import type { GetOperation, SetOperation, HasPropertyOperation, IrBlockId, IrBody, IrOperand, IrOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { observesNativeCarrierOnly, resultOfIrOperation } from './queries.js'
import { nativeMergePayloadTransportMatches } from './native-merge-transport.js'

/** A standard-prototype fact cites the exact source key and receiver. It
 * cannot be moved onto another HasProperty or invented from a public field.
 */
export const nativePropertyPrototypeAbsenceMatches = (
  operation: HasPropertyOperation | GetOperation | SetOperation,
  semantic: SemanticOperation | null,
  definitionOf: (value: IrValueId) => IrOperation | null,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  semanticOperationOf?: (lineage: import('../identity/ids.js').SemanticResultId) => SemanticOperation | null
): boolean => {
  const source =
    operation.kind === 'has-property' && semantic?.family === 'computation' && semantic.form === 'in'
      ? semantic
      : operation.kind === 'get' && semantic?.family === 'destructuring' && semantic.form === 'object-pattern'
        ? semantic
        : operation.kind === 'get' && semantic?.family === 'property' && semantic.internalMethod === 'get'
          ? semantic
          : operation.kind === 'set' && semantic?.family === 'property' && semantic.internalMethod === 'set'
            ? semantic
            : null
  if (source === null) return false
  if (operation.kind === 'set') {
    if (operation.ordinaryObjectDataWriteAbsent !== true || source.family !== 'property' || source.ordinaryObjectDataWriteAbsent !== true)
      return false
  } else if (operation.ordinaryObjectPrototypeKeyAbsent !== true || source.ordinaryObjectPrototypeKeyAbsent !== true) return false
  const key = operandOf(source, operation.kind === 'has-property' ? 'left' : 'key')
  const receiver = operandOf(source, source.family === 'property' ? 'receiver' : operation.kind === 'get' ? 'base' : 'right')
  if (key === undefined || receiver === undefined) return false
  const matches = (operand: IrOperand, expectedSource: OperandSource): boolean => {
    const seen = new Set<IrValueId>()
    let value = operand
    while (!seen.has(value.value)) {
      seen.add(value.value)
      const producer = definitionOf(value.value)
      if (!producer) return false
      const actual = resultOfIrOperation(producer)
      if (!actual || actual.id !== value.value || representationKey(actual.representation) !== representationKey(value.representation))
        return false
      let expected: OperandSource = expectedSource
      const aliases = new Set<import('../identity/ids.js').SemanticResultId>()
      for (;;) {
        if (expected.kind === 'constant') {
          if (producer.kind === 'constant') return producer.literal === expected.literal && producer.text === expected.text
          break
        }
        if (expected.kind === 'parameter') {
          if (producer.kind === 'parameter') return producer.ordinal === expected.ordinal
          break
        }
        if (expected.kind === 'receiver') {
          if (producer.kind === 'receiver') return true
          break
        }
        if (expected.kind !== 'result' || aliases.has(expected.result)) break
        aliases.add(expected.result)
        if (producer.lineage === expected.result) return true
        const original = semanticOperationOf?.(expected.result)
        const evaluated = original === null || original === undefined ? undefined : evaluatedResultIdentityOf(original, expected.result)
        if (evaluated !== undefined && evaluated !== expected.result) {
          expected = { kind: 'result', result: evaluated }
          continue
        }
        const identity = original === null || original === undefined ? undefined : identityOperandOf(original)
        if (identity === undefined) break
        expected = identity.source
      }
      // A Proxy internal method with no trap forwards to the target: the
      // source receiver is the proxy, the native receiver its target part.
      if (producer.kind === 'proxy-part' && producer.part === 'target') {
        value = producer.proxy
        continue
      }
      if (producer.kind === 'merge-live-arm-rebuild' && nativeMergePayloadTransportMatches(producer, conversions)) {
        value = producer.source
        continue
      }
      if (producer.kind !== 'convert') return false
      const node = conversions.nodeById(producer.conversionUse)
      if (
        !node ||
        representationKey(node.source) !== representationKey(producer.source.representation) ||
        representationKey(node.target) !== representationKey(producer.result.representation) ||
        (node.capability.kind !== 'identity' &&
          !nativeFieldViewIdentityTransportOf(node) &&
          !nativeArrayViewIdentityTransportOf(node, conversions.nodeById) &&
          !nativePayloadTransportMatches(node.source, node.target, node))
      )
        return false
      value = producer.source
    }
    return false
  }
  return matches(operation.key, key.source) && matches(operation.receiver, receiver.source)
}

/** This edge proves own presence only when the caller separately supplies a
 * complete ordinary-allocation descriptor domain and standard-prototype fact.
 * @semanticCategory generic-primitive
 */
export interface NativePropertyPresenceGuard {
  readonly has: HasPropertyOperation
  readonly key: string
  readonly present: boolean
}

/** A physical slot permits an own property but does not prove it present:
 * optional slots and configurable descriptors can be absent. Only the true
 * Has edge can exclude allocations with no possible native slot.
 */
export const nativePropertyPresenceStorageCandidatesOf = <T>(
  guard: NativePropertyPresenceGuard,
  candidates: readonly T[],
  hasSlot: (candidate: T, key: string) => boolean
): readonly T[] => (guard.present ? candidates.filter((candidate) => hasSlot(candidate, guard.key)) : candidates)

/** A local Has guard is not a type narrowing: aliases must retain one source
 * object, the proving edge must dominate, and every intervening effect must
 * preserve its descriptor. Exception/cleanup entries are considered too.
 */
export const nativePropertyPresenceAuthorityOf = (
  body: IrBody,
  conversions: Pick<ConversionCensus, 'nodeById'>
): ((
  receiver: IrOperand,
  key: string,
  at: IrOperation,
  preserves: (operation: IrOperation, guard: NativePropertyPresenceGuard) => boolean
) => NativePropertyPresenceGuard | null) => {
  if (
    ![...body.blocks.values()].some((block) =>
      [...allOperationsOf(block)].some(
        (operation) => operation.kind === 'has-property' && operation.ordinaryObjectPrototypeKeyAbsent === true
      )
    )
  )
    return () => null
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, { readonly block: IrBlockId; readonly index: number }>()
  const writes = new Map<string, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  for (const block of body.blocks.values())
    for (const [index, operation] of allOperationsOf(block).entries()) {
      positions.set(operation, { block: block.id, index })
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
      if (operation.kind === 'binding-write') {
        const entries = writes.get(operation.declaration) ?? []
        entries.push(operation)
        writes.set(operation.declaration, entries)
      }
    }
  const dominance = dominatorTreeOf(body)
  const graph = controlFlowGraphOf(body)
  const implicit = implicitSuccessorsOf(body, graph)
  const predecessors = new Map([...graph.predecessors].map(([block, incoming]) => [block, new Set(incoming)]))
  for (const [from, targets] of implicit) for (const to of targets) predecessors.get(to)?.add(from)
  const successorsOf = (block: IrBlockId): readonly IrBlockId[] => [...(graph.successors.get(block) ?? []), ...(implicit.get(block) ?? [])]
  const roots = new Map<IrValueId, IrValueId | null>()
  const rootOf = (value: IrValueId): IrValueId | null => {
    if (roots.has(value)) return roots.get(value)!
    roots.set(value, null)
    const producer = definitions.get(value)
    let root: IrValueId | null = value
    if (producer?.kind === 'convert') {
      const node = conversions.nodeById(producer.conversionUse)
      root =
        node &&
        representationKey(node.source) === representationKey(producer.source.representation) &&
        representationKey(node.target) === representationKey(producer.result.representation) &&
        (node.capability.kind === 'identity' ||
          nativeFieldViewIdentityTransportOf(node) ||
          nativePayloadTransportMatches(node.source, node.target, node))
          ? rootOf(producer.source.value)
          : value
    } else if (producer?.kind === 'binding-read') {
      const entries = writes.get(producer.declaration)
      const initialization = entries?.length === 1 ? entries[0] : undefined
      const before = initialization && positions.get(initialization)
      const after = positions.get(producer)
      root =
        before && after && dominance.dominates(before.block, after.block) && (before.block !== after.block || before.index < after.index)
          ? rootOf(initialization!.value.value)
          : value
    } else if (
      (producer?.kind === 'set' || producer?.kind === 'define-own-property') &&
      producer.result &&
      representationKey(producer.result.representation) === representationKey(producer.receiver.representation)
    )
      root = rootOf(producer.receiver.value)
    roots.set(value, root)
    return root
  }
  const guards: { readonly guard: NativePropertyPresenceGuard; readonly from: IrBlockId; readonly edge: IrBlockId }[] = []
  for (const block of body.blocks.values()) {
    const branch = block.terminator
    if (branch.kind !== 'branch') continue
    let condition = definitions.get(branch.condition.value)
    if (condition?.kind === 'test' && condition.predicate === 'to-boolean') condition = definitions.get(condition.value.value)
    if (condition?.kind !== 'has-property' || condition.ordinaryObjectPrototypeKeyAbsent !== true) continue
    const key = definitions.get(condition.key.value)
    if (key?.kind !== 'constant' || key.literal !== 'string') continue
    for (const [edge, present] of [
      [branch.whenTrue, true],
      [branch.whenFalse, false]
    ] as const)
      if (predecessors.get(edge)?.size === 1 && predecessors.get(edge)?.has(block.id))
        guards.push({ guard: { has: condition, key: key.text, present }, from: block.id, edge })
  }
  const canReach = (from: IrBlockId, to: IrBlockId): boolean => {
    const pending = [from]
    const visited = new Set<IrBlockId>()
    while (pending.length) {
      const block = pending.pop()!
      if (block === to) return true
      if (visited.has(block)) continue
      visited.add(block)
      pending.push(...successorsOf(block))
    }
    return false
  }
  const edgeDominates = (from: IrBlockId, edge: IrBlockId, at: IrBlockId): boolean => {
    // Removing the proving edge must disconnect the observation even across
    // exception and iterator cleanup edges, which the ordinary tree omits.
    const pending = [body.entry]
    const visited = new Set<IrBlockId>()
    while (pending.length) {
      const block = pending.pop()!
      if (block === at) return false
      if (visited.has(block)) continue
      visited.add(block)
      pending.push(...successorsOf(block).filter((next) => block !== from || next !== edge))
    }
    return true
  }
  return (receiver, key, at, preserves) => {
    const end = positions.get(at)
    const subject = rootOf(receiver.value)
    if (!end || subject === null) return null
    for (const candidate of guards) {
      const { guard, edge, from } = candidate
      const begin = positions.get(guard.has)!
      if (
        begin.block !== from ||
        guard.key !== key ||
        rootOf(guard.has.receiver.value) !== subject ||
        !edgeDominates(from, edge, end.block)
      )
        continue
      let intact = true
      const pending = [{ block: begin.block, index: begin.index + 1 }]
      const visited = new Set<IrBlockId>()
      while (pending.length && intact) {
        const cursor = pending.pop()!
        if (visited.has(cursor.block)) continue
        visited.add(cursor.block)
        const block = body.blocks.get(cursor.block)!
        const limit = cursor.block === end.block ? end.index : block.operations.length
        for (const operation of block.operations.slice(cursor.index, limit))
          if (
            !observesNativeCarrierOnly(operation) &&
            !['constant', 'binding-read', 'parameter', 'receiver'].includes(operation.kind) &&
            !preserves(operation, guard)
          ) {
            intact = false
            break
          }
        if (cursor.block === end.block) continue
        // Only the selected edge leaves the guard's own block. Re-entering it
        // is refused: the current edge cannot authenticate another iteration.
        for (const next of cursor.block === begin.block ? [edge] : successorsOf(cursor.block)) {
          if (next === begin.block) intact = false
          else if (canReach(next, end.block)) pending.push({ block: next, index: 0 })
        }
      }
      if (intact) return guard
    }
    return null
  }
}
