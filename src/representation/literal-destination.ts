import type { SemanticResultId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { RepresentationDeriver } from './derive.js'
import { representationKey, type Representation } from './model.js'
import { nativeTotalSelectionStepOf } from '../conversion/native-selection.js'

/**
 * An object literal minted directly as the carrier of the one place it goes.
 *
 * `{ data, width, height }` initializing a cell declared
 * `{data: TypedArray, width: number, height: number}` derives, from the
 * literal's own checker type, an anonymous record whose `data` still admits
 * the constructor's `null` default. Selecting that carrier and then
 * converting it into the cell's record is a structural record rebuild
 * (`view:structural-record`) of a value nobody else ever observes: the
 * literal is fresh, so it has no identity to keep, and its only consumer is
 * that one initializer. The plan is the authority for what the value
 * physically is, so the literal is published here as the destination's
 * record instead. Each member install then stores into the destination's own
 * field (`projection/slots.ts`'s `storeSlot` -> `fieldSlot`) through the
 * ordinary census node for that field pair. Only a member whose entry into
 * that field is TOTAL is admitted (below), so the override never asks an
 * install for a narrowing -- a presence test, a downcast -- it cannot prove.
 *
 * Admitted only when every one of these holds; otherwise the literal keeps
 * its structural derivation and whatever conversion plan it had:
 * - the literal's own members are plain data installs under constant keys
 *   (no spread protocol, accessor, computed key or non-default attributes --
 *   anything else citing the fresh object is a second consumer);
 * - across the literal and its installs there is exactly ONE outside
 *   citation, and it is a `binding` initialization's `initializer`;
 * - both carriers are plain records (no accessors) with the same ownership
 *   and the SAME key set, which is also the set of keys the installs write --
 *   an extra key the destination cannot hold, or a destination field the
 *   literal never writes, refuses;
 * - every member's carrier enters the destination's field TOTALLY
 *   (`nativeTotalSelectionStepOf`): a field the literal may hold `null` in
 *   but the destination declares non-null would need a presence proof the
 *   install does not have, so it refuses rather than certify `(*value)`.
 *
 * The answer is keyed by every result of the literal's own chain -- the
 * allocation and each install, which all publish the literal's type -- so the
 * whole chain commits one carrier.
 */
export const literalDestinationsOf = (
  graph: Pick<SemanticGraph, 'operations'>,
  deriver: Pick<RepresentationDeriver, 'derive' | 'deriveStored'>
): ReadonlyMap<SemanticResultId, Representation> => {
  const citations = new Map<SemanticResultId, { readonly operation: SemanticOperation; readonly operand: SemanticOperand }[]>()
  for (const operation of graph.operations.values())
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result') continue
      const cited = citations.get(operand.source.result) ?? []
      cited.push({ operation, operand })
      citations.set(operand.source.result, cited)
    }
  const destinations = new Map<SemanticResultId, Representation>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'allocation' || operation.allocated !== 'object-literal') continue
    const own = operation.results.length === 1 ? operation.results[0] : undefined
    if (!own || own.role !== 'value') continue
    const installs: SemanticOperation[] = []
    const outside: { readonly operation: SemanticOperation; readonly operand: SemanticOperand }[] = []
    for (const citation of citations.get(own.id) ?? [])
      if (isOwnInstall(citation.operation, citation.operand)) installs.push(citation.operation)
      else outside.push(citation)
    for (const install of installs) for (const result of install.results) outside.push(...(citations.get(result.id) ?? []))
    const sole = outside.length === 1 ? outside[0] : undefined
    if (!sole || !isInitializer(sole.operation, sole.operand)) continue
    const cell = sole.operation.results.length === 1 ? sole.operation.results[0] : undefined
    if (!cell) continue
    const literal = deriver.derive(own.type)
    const target = deriver.deriveStored(cell.type)
    if (literal.kind !== 'record' || target.kind !== 'record') continue
    if (literal.accessors.length > 0 || target.accessors.length > 0 || literal.ownership !== target.ownership) continue
    if (representationKey(literal) === representationKey(target)) continue
    const targetKeys = new Set(target.fields.map((field) => field.key))
    const sameKeys = (keys: ReadonlySet<string>): boolean => keys.size === targetKeys.size && [...keys].every((key) => targetKeys.has(key))
    if (!sameKeys(new Set(literal.fields.map((field) => field.key)))) continue
    if (!sameKeys(new Set(installs.map(installedKeyOf)))) continue
    // Every member must enter its destination field TOTALLY. A partial entry --
    // `data: ?Uint8Array` stored into `data: Uint8Array`, whose only recipe is
    // the present-optional load `(*data)` -- needs a presence proof no install
    // site has: the value the literal holds may still be `null`. Choosing the
    // destination there would certify an unguarded unwrap, so the literal
    // keeps its own carrier and whatever plan it had.
    const held = new Map(literal.fields.map((field) => [field.key, field.value]))
    if (
      !target.fields.every((field) => {
        const value = held.get(field.key)
        return (
          value !== undefined &&
          (representationKey(value) === representationKey(field.value) || nativeTotalSelectionStepOf(value, field.value) !== null)
        )
      })
    )
      continue
    destinations.set(own.id, target)
    for (const install of installs) for (const result of install.results) destinations.set(result.id, target)
  }
  return destinations
}

/** `CreateDataPropertyOrThrow` of one of the literal's own members onto the fresh object. */
const isOwnInstall = (operation: SemanticOperation, operand: SemanticOperand): boolean => {
  if (operation.family !== 'property' || operation.internalMethod !== 'define-own-property' || operation.keyIsComputed) return false
  if (operand.role !== 'receiver' || operand.evaluation.kind !== 'provenance') return false
  const descriptor = operation.descriptor
  if (!descriptor || descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true) return false
  if (operation.results.length !== 1) return false
  return keyOperandOf(operation)?.source.kind === 'constant'
}

const keyOperandOf = (operation: SemanticOperation): SemanticOperand | undefined =>
  operation.operands.find((operand) => operand.role === 'key' && operand.ordinal === 0)

const installedKeyOf = (install: SemanticOperation): string => {
  const source = keyOperandOf(install)?.source
  return source?.kind === 'constant' ? source.text : ''
}

/** A plain lexical cell initialized with the value, evaluated unconditionally. */
const isInitializer = (operation: SemanticOperation, operand: SemanticOperand): boolean =>
  operation.family === 'binding' &&
  operation.action === 'initialize' &&
  operation.parameterInitialization !== true &&
  operation.external === undefined &&
  operation.commonJs === undefined &&
  operand.role === 'initializer' &&
  operand.evaluation.kind === 'runtime'
