import type { SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { StructuralShape, StructuralType } from '../semantics/model/structural-types.js'
import { recordFieldKeyOf } from './object-shape.js'
import type { HostBindingPolicy } from './policies.js'

/**
 * The REQUIRED members of a record type that some object of it is created
 * without, and every read of one.
 *
 * A TypeScript type states what a program promises to put on an object, not
 * what the object has when it is made. `Object.create(null)` is an ordinary
 * object with no own properties at all (ECMA-262 20.1.2.2), and `{} as T` or
 * `{ a } as T` is a literal with exactly the members it spells: the assertion
 * changes the checker's type and never the value. Until the program writes a
 * member it is absent -- a read yields `undefined`, and `in`,
 * `hasOwnProperty` and `Object.keys` do not see it. The declared type
 * `b: Inner` says nothing about that window.
 *
 * An options parser `parseOptions(...): Options` builds `const options =
 * Object.create(null)`, writes only the options it was given, and then asks
 * `if (client && options.encryption)`. `encryption` is required in `Options`;
 * laid out required, the struct started it present (an empty `Ref` behind a
 * presence bit fixed `true`), the read was the bare member, and an object's
 * truthiness is `true` -- so the guarded setup ran and threw where node
 * skips it.
 *
 * Such a member is therefore laid out the way an optional one is: its own
 * presence bit, starting absent, set by every write, and a value carrier that
 * holds `undefined` (`derive.ts`'s `recordFieldsOf`). A read of it publishes
 * that carrier too, so the read honours the bit and a test of it sees the
 * absence; a read feeding a position that states the member's type converts
 * through the ordinary checked unwrap, exactly as `unassigned-binding-cells.ts`
 * does for a `let` read before any write.
 *
 * Keyed by the record's OBJECT shape -- the id `derive.ts`'s `deriveObject`
 * lays a record out under, which a declared name reaches through its body --
 * because that is the one layout every carrier of the type shares. Structural
 * types intern by structure, so an unrelated type with the identical member
 * list shares the answer; that only makes its layout admit an absence it may
 * never see, which is conservative.
 *
 * A literal whose installs cannot be named (a computed key, a spread) is not a
 * creation site this can read: it may install any member, and claiming one
 * absent from it would be a guess.
 */
export interface UnwrittenRecordMembers {
  /** The absent-at-creation required members, by record object shape. */
  readonly members: ReadonlyMap<StructuralTypeId, ReadonlySet<string>>
  /** Every constant-keyed read of one of those members. */
  readonly reads: ReadonlySet<SemanticResultId>
}

export const noUnwrittenRecordMembers: UnwrittenRecordMembers = { members: new Map(), reads: new Set() }

/** The object shape a record carrier of `id` is laid out under, or `null` for a type that is not one. */
export const recordObjectShapeOf = (
  types: ReadonlyMap<StructuralTypeId, StructuralType>,
  id: StructuralTypeId
): StructuralTypeId | null => {
  let current: StructuralTypeId | null = id
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    const shape: StructuralShape | undefined = types.get(current)?.shape
    if (!shape) return null
    if (shape.kind === 'object') return current
    if (shape.kind === 'declared' || shape.kind === 'object-anchor') current = shape.body
    // An intersection lays out as the object the checker reduces it to
    // (`derive.ts` derives `resolved`) -- the fresh `{}` of
    // `Object.assign({}, a, b)` is exactly such a `A & B`.
    else if (shape.kind === 'intersection' && shape.resolved !== null) current = shape.resolved
    else return null
  }
  return null
}

const requiredDataMembersOf = (shape: Extract<StructuralShape, { kind: 'object' }>): readonly string[] =>
  shape.members
    .filter((member) => !member.optional && member.accessor === null && member.key.kind !== 'symbol')
    .map((member) => recordFieldKeyOf(member.key))

/**
 * `Object.create(null)`: the callee is `create` read off the `ObjectConstructor`
 * host protocol -- by the get's own host-method binding where the producer
 * attached one, else by the receiver's declared type, the same two readings
 * `ir/instance-reparenting.ts` makes for `setPrototypeOf` -- and its one
 * argument is the `null` literal.
 */
const isObjectConstructorCall = (
  graph: SemanticGraph,
  binding: HostBindingPolicy,
  operation: SemanticOperation,
  member: string
): boolean => {
  if (operation.family !== 'invocation' || operation.internalMethod !== 'call') return false
  const callee = operandOf(operation, 'callee')
  if (callee?.source.kind !== 'result') return false
  const producerId = graph.results.get(callee.source.result)
  const producer = producerId === undefined ? undefined : graph.operations.get(producerId)
  if (producer?.family !== 'property' || producer.internalMethod !== 'get') return false
  if (producer.hostMethod) return producer.hostMethod.protocol === 'ObjectConstructor' && producer.hostMethod.member === member
  const key = operandOf(producer, 'key')
  if (key?.source.kind !== 'constant' || key.source.text !== member) return false
  const receiver = operandOf(producer, 'receiver')
  const shape = receiver ? graph.structuralTypes.get(receiver.type)?.shape : undefined
  return shape?.kind === 'declared' && binding.forDeclaration(shape.declaration)?.protocol === 'ObjectConstructor'
}

const isObjectCreateNull = (graph: SemanticGraph, binding: HostBindingPolicy, operation: SemanticOperation): boolean => {
  const argument = operandOf(operation, 'argument', 0)
  if (argument?.source.kind !== 'constant' || argument.source.literal !== 'null' || operandOf(operation, 'argument', 1)) return false
  if (operation.operands.some((operand) => operand.role === 'spread-argument')) return false
  return isObjectConstructorCall(graph, binding, operation, 'create')
}

/**
 * The object `Object.assign(target, ...sources)` copies into, when that target
 * is the result of a program operation. A fresh `{}` in that position is laid
 * out as the call's whole `T & U` (`objectAssignFreshTargetType`), yet it is
 * created empty and holds afterwards exactly the keys the sources hold at the
 * copy -- which an `any`-built source (`parseOptions`' `Object.create(null)`
 * behind a client's `this.options`) need not.
 */
const objectAssignTargetOf = (graph: SemanticGraph, binding: HostBindingPolicy, operation: SemanticOperation): SemanticResultId | null => {
  const target = operandOf(operation, 'argument', 0)
  if (target?.source.kind !== 'result' || !operandOf(operation, 'argument', 1)) return null
  if (operation.operands.some((operand) => operand.role === 'spread-argument')) return null
  return isObjectConstructorCall(graph, binding, operation, 'assign') ? target.source.result : null
}

const constantKeyOf = (operation: SemanticOperation): string | null => {
  const key = operandOf(operation, 'key')
  return key?.source.kind === 'constant' ? key.source.text : null
}

export const unwrittenRecordMembersOf = (graph: SemanticGraph, binding: HostBindingPolicy): UnwrittenRecordMembers => {
  const types = graph.structuralTypes
  const members = new Map<StructuralTypeId, Set<string>>()
  const absent = (shapeId: StructuralTypeId, keys: Iterable<string>): void => {
    for (const key of keys) {
      const known = members.get(shapeId)
      if (known) known.add(key)
      else members.set(shapeId, new Set([key]))
    }
  }
  // A literal's own installs cite it as a provenance receiver; anything else
  // that does (a spread's `CopyDataProperties`, a computed-key define) may
  // install any member.
  const installs = new Map<SemanticResultId, { keys: Set<string>; unknown: boolean }>()
  const installsOf = (result: SemanticResultId): { keys: Set<string>; unknown: boolean } => {
    const known = installs.get(result)
    if (known) return known
    const fresh = { keys: new Set<string>(), unknown: false }
    installs.set(result, fresh)
    return fresh
  }
  const literals: { readonly result: SemanticResultId; readonly shapeId: StructuralTypeId }[] = []
  const assignTargets = new Set<SemanticResultId>()
  for (const operation of graph.operations.values()) {
    const assignTarget = objectAssignTargetOf(graph, binding, operation)
    if (assignTarget !== null) assignTargets.add(assignTarget)
    if (isObjectCreateNull(graph, binding, operation)) {
      const value = resultOf(operation, 'value')
      const shapeId = value ? recordObjectShapeOf(types, value.type) : null
      const shape = shapeId === null ? undefined : types.get(shapeId)?.shape
      if (shapeId !== null && shape?.kind === 'object') absent(shapeId, requiredDataMembersOf(shape))
      continue
    }
    if (operation.family === 'allocation' && operation.allocated === 'object-literal') {
      const value = resultOf(operation, 'value')
      const shapeId = value ? recordObjectShapeOf(types, value.type) : null
      if (value && shapeId !== null) literals.push({ result: value.id, shapeId })
      continue
    }
    const receiver: SemanticOperand | undefined = operandOf(operation, 'receiver')
    if (receiver?.source.kind !== 'result' || receiver.evaluation.kind !== 'provenance') continue
    const cited = installsOf(receiver.source.result)
    const key =
      operation.family === 'property' && operation.internalMethod === 'define-own-property' && !operation.keyIsComputed
        ? constantKeyOf(operation)
        : null
    if (key === null) cited.unknown = true
    else cited.keys.add(key)
  }
  for (const literal of literals) {
    const shape = types.get(literal.shapeId)?.shape
    if (shape?.kind !== 'object') continue
    const installed = installs.get(literal.result)
    // The copy is what cites an assign target as unknown: it installs exactly
    // the keys its sources hold, so the literal's required members are absent
    // until it does -- the same window `Object.create(null)` opens.
    if (installed?.unknown && !assignTargets.has(literal.result)) continue
    absent(
      literal.shapeId,
      requiredDataMembersOf(shape).filter((key) => !installed?.keys.has(key))
    )
  }
  const reads = new Set<SemanticResultId>()
  if (members.size === 0) return { members, reads }
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) continue
    const key = constantKeyOf(operation)
    const receiver = operandOf(operation, 'receiver')
    const value = resultOf(operation, 'value')
    if (key === null || !receiver || !value) continue
    const shapeId = recordObjectShapeOf(types, receiver.type)
    if (shapeId !== null && members.get(shapeId)?.has(key)) reads.add(value.id)
  }
  return { members, reads }
}
