import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredRecordFieldOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { PropertyOperation } from '../semantics/model/operations.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf } from '../semantics/model/operands.js'
import type { StructuralShape } from '../semantics/model/structural-types.js'

/**
 * The property family's two SEALED computed-key certificates.
 *
 * A computed key whose semantic type is a finite set of string literals is a
 * closed question, but only while the semantic graph is still in hand: by
 * emission time the key is a `std::string` and the literal union that bounded
 * it is gone. So the fact is asked ONCE here, during lowering, and carried on
 * the operation for the printer to spell -- the read side as
 * `GetOperation.typedComputedRead`, the write side as
 * `SetOperation.typedComputedWrite`. Both share `stringLiteralTextsOf`, which
 * is the one authority for "what strings can this key be"; neither re-derives
 * it, and the emitter has no way to ask it.
 */

/** One fixed field arm of a sealed computed read. */
export interface TypedComputedReadArm {
  readonly key: string
  readonly source: Representation
  /** The conversion census node that carries this field into the get result. */
  readonly conversion: ConversionNodeId
}

/**
 * A fixed-field read over a closed data record. String literal keys bound
 * the selected arms; numeric keys use all fields and an explicit absence arm.
 * The emitter may switch on the key,
 * but it must keep the ordinary dynamic route when this certificate is absent.
 */
export interface TypedComputedReadRecipe {
  readonly kind: 'closed-record'
  readonly receiver: string
  readonly result: string
  readonly arms: readonly TypedComputedReadArm[]
  /**
   * Present when the RECEIVER bounds the arms rather than the key's own value
   * set: the key can miss every fixed field, so absence needs its own sealed
   * conversion. `carrier` is the key carrier the arms were selected for, so a
   * later carrier change invalidates the certificate instead of silently
   * changing which route runs.
   */
  readonly receiverBounded?: { readonly carrier: string; readonly missing: ConversionNodeId }
}

/**
 * A key whose value set cannot be enumerated, so the record's own fields bound
 * the read instead. Numeric and nullish keys were always here; a plain `string`
 * key belongs for the same reason, and it is the common case -- `for (const key
 * in values) target[key]`, a shader-chunk table read by name -- that otherwise
 * costs the whole receiver its sealed field protocol.
 *
 * The comment this replaces excluded strings because a string key CAN name
 * `Object.prototype.toString` while a numeric one cannot. That is a true fact
 * about JavaScript and the wrong test for this recipe: the route this
 * certificate replaces is `gea_readOwnField`, an OWN-property read over a
 * record with no prototype object in the model at all, so absence already
 * answers `undefined` on both routes. The switch changes which instructions
 * run, never which value comes back.
 *
 * Symbol keys stay out. A symbol is not addressable by a string field switch
 * and cannot be rendered into one, which is also why symbol-keyed fields
 * disqualify the receiver above.
 */
const receiverBoundedPropertyKeyOf = (key: Representation): boolean => {
  if (key.kind === 'null' || key.kind === 'undefined' || key.kind === 'string') return true
  if (key.kind === 'optional') return receiverBoundedPropertyKeyOf(key.payload)
  if (key.kind === 'tagged-union') return key.arms.length > 0 && key.arms.every((arm) => receiverBoundedPropertyKeyOf(arm.value))
  return key.kind === 'scalar' && (key.domain === 'number' || key.domain === 'int32' || key.domain === 'uint32' || key.domain === 'float64')
}

const stringLiteralTextsOf = (
  graph: SemanticGraph,
  type: StructuralTypeId,
  visited = new Set<StructuralTypeId>()
): readonly string[] | null => {
  if (visited.has(type)) return null
  visited.add(type)
  const entry = graph.structuralTypes.get(type)
  if (!entry) return null
  const shape: StructuralShape = entry.shape
  if (shape.kind === 'literal') return shape.primitive === 'string' ? [shape.text] : null
  if (shape.kind === 'declared' && shape.body !== null) return stringLiteralTextsOf(graph, shape.body, visited)
  if (shape.kind !== 'union' || shape.members.length === 0) return null
  const texts: string[] = []
  for (const member of shape.members) {
    const nested = stringLiteralTextsOf(graph, member, new Set(visited))
    if (nested === null) return null
    texts.push(...nested)
  }
  return [...new Set(texts)].sort()
}

/**
 * Publishes a candidate fixed-field computed-read recipe from the
 * semantic/representation contracts. A later whole-program reflection census
 * is the authority for whether the receiver can escape to mutation, an
 * accessor, or an unknown call; that finalization pass must revoke this
 * candidate when it finds such demand. This selector deliberately excludes
 * index-bearing, accessor-bearing, symbol-bearing and optional layouts: each
 * can have an additional runtime answer that a direct field switch would
 * erase even before whole-program exposure is considered.
 */
export const typedComputedReadRecipeOf = (
  graph: SemanticGraph,
  operation: PropertyOperation,
  receiver: Representation,
  result: Representation,
  keyRepresentation: Representation,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus
): TypedComputedReadRecipe | null => {
  if (operation.internalMethod !== 'get' || !operation.keyIsComputed) return null
  if (receiver.kind !== 'record' || receiver.accessors.length !== 0) return null
  if (receiver.fields.some((field) => !field.required || field.key.startsWith('sym('))) return null
  if (!operandOf(operation, 'receiver')) return null
  const keyOperand = operandOf(operation, 'key')
  if (!keyOperand) return null
  let keys = stringLiteralTextsOf(graph, keyOperand.type)
  let receiverBounded: TypedComputedReadRecipe['receiverBounded']
  if (keys === null && receiverBoundedPropertyKeyOf(keyRepresentation)) {
    const missing = conversions.nodeFor({ kind: 'undefined' }, result)
    if (missing.capability.kind === 'never') return null
    // The receiver, rather than the key's value set, bounds these arms.
    // Exposure finalization still revokes this recipe for unknown mutation.
    keys = receiver.fields.map((field) => field.key)
    receiverBounded = { carrier: representationKey(keyRepresentation), missing: missing.id }
  }
  if (keys === null || keys.length === 0) return null
  const arms: TypedComputedReadArm[] = []
  for (const key of keys) {
    const field = declaredRecordFieldOf(deriver, receiver, key, classes)
    if (field === null) return null
    const conversion = conversions.nodeFor(field.value, result)
    if (conversion.capability.kind === 'never') return null
    arms.push({ key, source: field.value, conversion: conversion.id })
  }
  if (arms.length === 0 || arms.some((arm) => representationKey(arm.source) === 'unresolved')) return null
  return {
    kind: 'closed-record',
    receiver: representationKey(receiver),
    result: representationKey(result),
    arms,
    ...(receiverBounded === undefined ? {} : { receiverBounded })
  }
}

/**
 * A computed WRITE whose semantic key is a finite set of string literals, each
 * naming a declared field of the receiver.
 *
 * The read's twin, and deliberately thinner. The read recipe carries a
 * conversion node per arm because the emitter renders the field load itself;
 * the write recipe carries only the KEYS, because the emitter renders each arm
 * by re-entering the ordinary CONSTANT-key store path with that key
 * (`emit-properties.ts`). That is the whole point of the shape: a computed
 * store into a declared field must reach the same storage, the same
 * conversion, the same setter and the same reactive tick a source-literal
 * store to that member reaches -- and the only way to guarantee it is to call
 * that renderer, not to re-implement its tail.
 *
 * What this buys over the runtime field dispatcher (`gea_writeOwnField`, which
 * `class-ref:set:true` already claims) is the carriers it cannot address. The
 * dispatcher goes through `gea::Value`, so a field whose carrier has no tag --
 * an `optional`, an iterator, a CALLABLE -- refuses at run time by name
 * (`refuseUnaddressableField`). `this[name] = fn` where `name: 'a' | 'b'` and
 * both fields hold a callable is a perfectly static write that the dynamic
 * route cannot express; asked as a closed set, it is two ordinary stores.
 */
export interface TypedComputedWriteRecipe {
  readonly kind: 'closed-record'
  readonly receiver: string
  readonly keys: readonly string[]
}

/**
 * Publishes a candidate closed computed-write recipe.
 *
 * The exclusions are the read's, for the read's reasons, plus one of its own:
 * an ACCESSOR anywhere on the receiver means a key might name a setter rather
 * than storage, and a field switch would write past it. Symbol keys cannot be
 * named by a string literal at all. A field that is not required carries a
 * presence bit, which the constant-key renderer does set -- so those are
 * admitted, and it is the accessor case alone that is refused here.
 */
export const typedComputedWriteRecipeOf = (
  graph: SemanticGraph,
  operation: PropertyOperation,
  receiver: Representation,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): TypedComputedWriteRecipe | null => {
  if (operation.internalMethod !== 'set' || !operation.keyIsComputed) return null
  if (receiver.kind === 'record' && receiver.accessors.length !== 0) return null
  if (receiver.kind !== 'record' && receiver.kind !== 'class-ref') return null
  if (receiver.kind === 'class-ref' && classAccessorKeysOf(classes, receiver.declaration).size !== 0) return null
  if (!operandOf(operation, 'receiver')) return null
  const keyOperand = operandOf(operation, 'key')
  if (!keyOperand) return null
  const keys = stringLiteralTextsOf(graph, keyOperand.type)
  if (keys === null || keys.length === 0) return null
  if (keys.some((key) => key.startsWith('sym('))) return null
  for (const key of keys) {
    const field = declaredRecordFieldOf(deriver, receiver, key, classes)
    if (field === null || representationKey(field.value) === 'unresolved') return null
  }
  return { kind: 'closed-record', receiver: representationKey(receiver), keys }
}

/** Every accessor key on a class and its bases -- the exclusion above, asked once. */
const classAccessorKeysOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): ReadonlySet<string> => {
  const keys = new Set<string>()
  const seen = new Set<DeclarationId>()
  let current: DeclarationId | null = declaration
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const layout: ClassLayout | undefined = classes.get(current)
    if (!layout) break
    for (const accessor of layout.accessors) keys.add(accessor.key)
    current = layout.base
  }
  return keys
}
