import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { representationKey, type Representation } from '../representation/model.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { dominatorTreeOf } from './dominance.js'
import { allOperationsOf, type DeadLogicalMergeValueOperation, type IrBody, type IrOperation } from './model.js'

/** A source-object fact licenses only the exact && left's falsy control edge,
 * never an ordinary conversion of a shared reference into the result carrier.
 * The fact is either the semantic one (`logicalLeftObjectTruthy`, every source
 * value an object-producing expression) or this body's own definitions of the
 * left value (`objectValued` below), for a left the source session cannot see
 * through: `x as T` out of an `any` value.
 */
export const deadLogicalMergeValueMatches = (
  operation: DeadLogicalMergeValueOperation,
  semantic: SemanticOperation | null,
  body: IrBody,
  semanticOperationOf?: (lineage: NonNullable<IrOperation['lineage']>) => SemanticOperation | null,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  if (
    semantic?.family !== 'computation' ||
    semantic.form !== 'logical' ||
    semantic.operator !== '&&' ||
    resultOf(semantic, 'value')?.id !== operation.lineage ||
    body.sourceOwner !== (semantic.caller.kind === 'function' ? semantic.caller.functionId : semantic.caller.regionId)
  )
    return false
  const left = operandOf(semantic, 'left')?.source
  if (left === undefined) return false
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, { readonly block: typeof body.entry; readonly index: number }>()
  const writes = new Map<DeclarationId, IrOperation[]>()
  let blockOf: typeof body.entry | null = null
  for (const block of body.blocks.values())
    for (const [index, item] of allOperationsOf(block).entries()) {
      if ('result' in item && item.result !== null) definitions.set(item.result.id, item)
      if (item === operation) blockOf = block.id
      positions.set(item, { block: block.id, index })
      if (item.kind === 'binding-write' || item.kind === 'binding-renew' || item.kind === 'allocate-constructor') {
        const bucket = writes.get(item.declaration)
        if (bucket) bucket.push(item)
        else writes.set(item.declaration, [item])
      }
    }
  if (blockOf === null) return false
  // A discarded or reconstructed value cannot borrow the source's
  // truthiness merely because the conversion still cites that SSA.
  const transportsIdentity = (producer: Extract<IrOperation, { kind: 'convert' }>): boolean => {
    const node = conversions?.nodeById(producer.conversionUse)
    return !(
      producer.rebuild !== undefined ||
      node === null ||
      node === undefined ||
      representationKey(node.source) !== representationKey(producer.source.representation) ||
      representationKey(node.target) !== representationKey(producer.result.representation) ||
      !recipeIsMaterializableWithoutPriorSourceGuard(node, conversions!.nodeById) ||
      (node.capability.kind !== 'identity' &&
        !(
          'materializer' in node.capability &&
          (node.capability.materializer.nativePayloadTransport === 'preserved' ||
            node.capability.materializer.callableIdentityTransport === 'preserved')
        ))
    )
  }
  const chain = (value: IrValueId): readonly IrValueId[] => {
    const values: IrValueId[] = []
    while (!values.includes(value)) {
      values.push(value)
      const producer = definitions.get(value)
      if (producer?.kind !== 'convert' || !transportsIdentity(producer)) break
      value = producer.source.value
    }
    return values
  }
  const aliases = chain(operation.source.value)
  if (
    !aliases.some((value) => {
      const producer = definitions.get(value)
      if (producer === undefined) return false
      if (left.kind === 'result') {
        if (producer.lineage !== left.result || producer.kind === 'convert') return false
        const source = semanticOperationOf?.(left.result)
        if (source?.family === 'binding')
          return source.action === 'read' && producer.kind === 'binding-read' && producer.declaration === source.declaration
        return source !== null && source !== undefined && resultOf(source, 'value')?.id === left.result
      }
      if (left.kind === 'parameter') return producer.kind === 'parameter' && producer.ordinal === left.ordinal
      return left.kind === 'receiver' && producer.kind === 'receiver'
    })
  )
    return false
  const dominance = dominatorTreeOf(body)
  /**
   * Every definition of `value` this body can reach is an Object: a fresh
   * allocation, or a checked assertion out of a box -- the conversion from
   * `dynamic` into a named record or a document refuses with a TypeError
   * whatever is not an object, so it never yields `undefined` (the one falsy
   * state of a shared record reference, its strict unbound-receiver lane) or
   * `null`. A `phi` holds what its incomings hold; a cell read holds what this
   * body wrote to it, when no other frame shares the cell and a write
   * dominates the read (a hoisted `var` reads `undefined` before it). A cycle
   * adds no definition of its own.
   */
  const objectValued = (start: IrValueId, open = new Set<IrValueId>()): boolean => {
    if (open.has(start)) return true
    open.add(start)
    const producer = definitions.get(start)
    if (producer === undefined) return false
    switch (producer.kind) {
      case 'allocate-ordinary-object':
      case 'allocate-array-object':
      case 'allocate-record':
        return true
      case 'convert':
        if (
          producer.rebuild === undefined &&
          producer.source.representation.kind === 'dynamic' &&
          checkedObjectAssertion(producer.result.representation)
        )
          return true
        return transportsIdentity(producer) && objectValued(producer.source.value, open)
      // An object literal's definitions publish the object they installed into
      // (`producers/allocations.ts`), so the literal's value is its receiver.
      case 'define-own-property':
        return (
          producer.result !== null &&
          representationKey(producer.result.representation) === representationKey(producer.receiver.representation) &&
          objectValued(producer.receiver.value, open)
        )
      case 'phi':
        return producer.incoming.length > 0 && producer.incoming.every((incoming) => objectValued(incoming.value.value, open))
      case 'binding-read': {
        const facts = body.facts
        if (facts === undefined || facts.boxed.has(producer.declaration) || facts.capturedDeclarations.includes(producer.declaration))
          return false
        const stores = writes.get(producer.declaration) ?? []
        const read = positions.get(producer)
        if (read === undefined || stores.length === 0 || !dominance.reachable.has(read.block)) return false
        if (stores.some((store) => store.kind !== 'binding-write' || !objectValued(store.value.value, open))) return false
        return stores.some((store) => {
          const at = positions.get(store)
          return at !== undefined && (at.block === read.block ? at.index < read.index : dominance.dominates(at.block, read.block))
        })
      }
      default:
        return false
    }
  }
  for (const block of body.blocks.values()) {
    const branch = block.terminator
    if (branch.kind !== 'branch' || !dominance.dominates(branch.whenFalse, blockOf)) continue
    const test = definitions.get(branch.condition.value)
    if (test?.kind === 'test' && test.predicate === 'to-boolean' && chain(test.value.value).some((value) => aliases.includes(value)))
      return semantic.logicalLeftObjectTruthy === true || objectValued(operation.source.value)
  }
  return false
}

const checkedObjectAssertion = (target: Representation): boolean => target.kind === 'native-record-ref' && target.native === null
