import type { DeclarationId, FunctionId, SemanticResultId } from '../identity/ids.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from './model/graph.js'
import { operandOf, resultOf } from './model/operands.js'
import type { BindingOperation, SemanticOperation } from './model/operations.js'

/**
 * Exact source-Function provenance carried by semantic results.
 *
 * Structural callable types are deliberately absent: two unrelated functions
 * may have the same signature and therefore the same StructuralTypeId. An
 * allocation is the only provenance root, because normalization puts its
 * checker-authenticated FunctionId on the operation. A binding preserves that
 * identity only when every write to the cell is itself already proven to be
 * the same function; aliases therefore compose, while reassignment, unions and
 * unknown writes fail closed.
 */
const callableOriginsByGraph = new WeakMap<SemanticGraph, ReadonlyMap<SemanticResultId, FunctionId>>()

export const callableOriginsOf = (graph: SemanticGraph): ReadonlyMap<SemanticResultId, FunctionId> => {
  const known = callableOriginsByGraph.get(graph)
  if (known) return known
  const origins = new Map<SemanticResultId, FunctionId>()
  const writes = new Map<DeclarationId, BindingOperation[]>()

  for (const operation of graph.operations.values()) {
    if (operation.family === 'allocation' && operation.allocated === 'function-object' && operation.callable !== null) {
      const value = resultOf(operation, 'value')
      if (value) origins.set(value.id, operation.callable)
      continue
    }
    if (operation.family !== 'binding' || (operation.action !== 'initialize' && operation.action !== 'write')) continue
    const bucket = writes.get(operation.declaration)
    if (bucket) bucket.push(operation)
    else writes.set(operation.declaration, [operation])
  }

  const cells = new Map<DeclarationId, FunctionId>()
  let changed = true
  while (changed) {
    changed = false

    for (const [declaration, operations] of writes) {
      if (cells.has(declaration)) continue
      let candidate: FunctionId | null = null
      let complete = true
      for (const operation of operations) {
        const source = operation.operands.find((operand) => operand.evaluation.kind !== 'provenance')?.source
        const origin = source?.kind === 'result' ? origins.get(source.result) : undefined
        if (origin === undefined || (candidate !== null && candidate !== origin)) {
          complete = false
          break
        }
        candidate = origin
      }
      if (!complete || candidate === null) continue
      cells.set(declaration, candidate)
      changed = true
    }

    for (const operation of graph.operations.values()) {
      // A `[[Set]]` publishes the RECEIVER it wrote into, not the stored value
      // (`producers/properties.ts` says so where it mints the result), so the
      // Function object the store threads onward is the one it was handed.
      // Writing an expando onto a callable was the second view of a boxed
      // callable that kept a native carrier while the object it restates was
      // `dynamic`.
      if (operation.family === 'property' && operation.internalMethod === 'set') {
        const receiver = operandOf(operation, 'receiver')
        const stored = receiver?.source.kind === 'result' ? origins.get(receiver.source.result) : undefined
        const value = resultOf(operation, 'value')
        if (stored !== undefined && value && !origins.has(value.id)) {
          origins.set(value.id, stored)
          changed = true
        }
      }
      if (operation.family !== 'binding') continue
      const origin = cells.get(operation.declaration)
      if (origin === undefined) continue
      const value = resultOf(operation, 'value')
      if (value && !origins.has(value.id)) {
        origins.set(value.id, origin)
        changed = true
      }
      // The REFERENCE this read takes `GetValue` of denotes the same Function
      // object the read produces -- ECMA-262 6.2.5.5 is one step over one cell,
      // and nothing between them can be a different function. Left unstamped,
      // a reference result was the one view of a boxed callable that kept a
      // native carrier while its own cell was `dynamic`, so `--dynamic-fallback`
      // emitted `CallableConstructorObject v = <gea::Value cell>` and the C++
      // did not compile (`dynamic-callable-abi-recovery.runtime.js`).
      for (const operand of operation.operands) {
        if (operand.source.kind !== 'result') continue
        const cited = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as never))
        if (cited?.family !== 'reference' || cited.form !== 'identifier') continue
        if (origins.has(operand.source.result)) continue
        origins.set(operand.source.result, origin)
        changed = true
      }
    }
  }

  callableOriginsByGraph.set(graph, origins)
  return origins
}

/**
 * Which source functions own a `prototype` object, keyed by the same
 * checker-authenticated `FunctionId` `callableOriginsOf` resolves a value to.
 *
 * The fact itself is the declaration's (`producers/shared.ts`'s
 * `ownPrototypePropertyOf`); this only indexes it by function, and only from
 * the allocation that states it -- a function whose allocation states nothing
 * is absent here, and absence is the third answer, never `false`.
 */
const ownPrototypeFactsByGraph = new WeakMap<SemanticGraph, ReadonlyMap<FunctionId, boolean>>()

const ownPrototypeFactsOf = (graph: SemanticGraph): ReadonlyMap<FunctionId, boolean> => {
  const known = ownPrototypeFactsByGraph.get(graph)
  if (known) return known
  const facts = new Map<FunctionId, boolean>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'allocation' || operation.callable === null) continue
    if (operation.ownPrototypeProperty === undefined) continue
    facts.set(operation.callable, operation.ownPrototypeProperty)
  }
  ownPrototypeFactsByGraph.set(graph, facts)
  return facts
}

/**
 * Whether the callable this operation reads through owns a `prototype`
 * object -- `null` where the graph cannot prove either answer.
 *
 * The one authority for the question `function-and-constructor` used to answer
 * by accident. That carrier owns a `prototype` because the checker gave the
 * value a construct signature, and `function-value-dispatch` was read as
 * owning none for the mirror-image reason -- which made "how is this value
 * invoked" and "does the declaration behind it have a `prototype`" one answer.
 * They are the same answer for every function until one is written as an
 * ordinary `function` and used only as a call, which is exactly where a
 * `Factory.prototype` read landed on a carrier that denied having one.
 *
 * `null` is returned for a value with no proven origin (a parameter, a union
 * of two functions, a reassigned cell) and for a generator, whose allocation
 * deliberately states nothing. Both keep the read refused rather than
 * answering `undefined` for a property that exists.
 */
export const callableOwnPrototypeAt = (graph: SemanticGraph, operation: SemanticOperation): boolean | null => {
  const receiver = operandOf(operation, 'receiver')
  if (receiver?.source.kind !== 'result') return null
  const origin = callableOriginsOf(graph).get(receiver.source.result)
  if (origin === undefined) return null
  return ownPrototypeFactsOf(graph).get(origin) ?? null
}

/** A computed key can overwrite either explicit-this builtin. */
export const unknownCallableOwnProperty = '*'

export interface CallableMutationFacts {
  readonly ownProperties: ReadonlyMap<FunctionId, ReadonlySet<string>>
  /** Writes through a callable value whose exact Function object is unknown. */
  readonly anonymousProperties: ReadonlySet<string>
  readonly functionPrototypeProperties: ReadonlySet<string>
}

const propertyNameOf = (operation: SemanticOperation, role: string, ordinal = 0): string => {
  const key = operandOf(operation, role, ordinal)
  return key?.source.kind === 'constant' && key.source.literal === 'string' ? key.source.text : unknownCallableOwnProperty
}

/** Semantic results proven to carry the one global Function.prototype object. */
const functionPrototypeOriginsByGraph = new WeakMap<SemanticGraph, ReadonlySet<SemanticResultId>>()

const functionPrototypeOriginsOf = (graph: SemanticGraph): ReadonlySet<SemanticResultId> => {
  const known = functionPrototypeOriginsByGraph.get(graph)
  if (known) return known
  const origins = new Set<SemanticResultId>()
  const writes = new Map<DeclarationId, BindingOperation[]>()
  for (const operation of graph.operations.values()) {
    if (operation.family === 'property' && operation.internalMethod === 'get' && operation.intrinsicValue === 'function-prototype') {
      const value = resultOf(operation, 'value')
      if (value) origins.add(value.id)
    }
    if (operation.family !== 'binding' || (operation.action !== 'initialize' && operation.action !== 'write')) continue
    const bucket = writes.get(operation.declaration)
    if (bucket) bucket.push(operation)
    else writes.set(operation.declaration, [operation])
  }

  const cells = new Set<DeclarationId>()
  let changed = true
  while (changed) {
    changed = false
    for (const [declaration, operations] of writes) {
      if (cells.has(declaration)) continue
      const complete =
        operations.length > 0 &&
        operations.every((operation) => {
          const source = operation.operands.find((operand) => operand.evaluation.kind !== 'provenance')?.source
          return source?.kind === 'result' && origins.has(source.result)
        })
      if (!complete) continue
      cells.add(declaration)
      changed = true
    }
    for (const operation of graph.operations.values()) {
      if (operation.family === 'binding' && cells.has(operation.declaration)) {
        const value = resultOf(operation, 'value')
        if (value && !origins.has(value.id)) {
          origins.add(value.id)
          changed = true
        }
      }
      if (operation.family === 'invocation' && operation.intrinsicMutation !== undefined && operation.intrinsicMutation !== 'reflect-set') {
        const target = operandOf(operation, 'argument', 0)
        const value = resultOf(operation, 'value')
        if (target?.source.kind === 'result' && origins.has(target.source.result) && value && !origins.has(value.id)) {
          origins.add(value.id)
          changed = true
        }
      }
    }
  }
  functionPrototypeOriginsByGraph.set(graph, origins)
  return origins
}

/**
 * Every own-property mutation this program performs through a value, as the
 * result it targets and the key it writes -- before anything decides WHICH
 * object that result denotes.
 *
 * The scan itself is the fact; who owns the write is a second question with
 * two different answers at two stages (`callableOwnPropertyWritesOf` needs
 * only the origin map and runs before a plan exists; `callableMutationFactsOf`
 * additionally classifies the writes whose origin is unknown, which needs the
 * sealed plan). Both read this one list rather than walking the graph again,
 * so a mutation form admitted here is admitted for both.
 */
interface CallableWriteTarget {
  readonly result: SemanticResultId
  readonly name: string
}

const callableWriteTargetsByGraph = new WeakMap<SemanticGraph, readonly CallableWriteTarget[]>()

const callableWriteTargetsOf = (graph: SemanticGraph): readonly CallableWriteTarget[] => {
  const known = callableWriteTargetsByGraph.get(graph)
  if (known) return known
  const targets: CallableWriteTarget[] = []
  for (const operation of graph.operations.values()) {
    if (operation.family === 'property') {
      if (operation.internalMethod !== 'set' && operation.internalMethod !== 'delete' && operation.internalMethod !== 'define-own-property')
        continue
      const receiver = operandOf(operation, 'receiver')
      if (receiver?.source.kind !== 'result') continue
      targets.push({ result: receiver.source.result, name: propertyNameOf(operation, 'key') })
      continue
    }
    if (operation.family !== 'invocation' || operation.intrinsicMutation === undefined) continue
    const target = operandOf(operation, 'argument', 0)
    if (target?.source.kind !== 'result') continue
    const name =
      operation.intrinsicMutation === 'object-assign' || operation.intrinsicMutation === 'object-define-properties'
        ? unknownCallableOwnProperty
        : propertyNameOf(operation, 'argument', 1)
    targets.push({ result: target.source.result, name })
  }
  callableWriteTargetsByGraph.set(graph, targets)
  return targets
}

/**
 * Own-property writes grouped by the exact Function object they PROVABLY
 * target -- the half of `callableMutationFactsOf` that needs no plan.
 *
 * Published separately because `representation/publish.ts` has to ask it: a
 * read of `call`/`apply`/`bind` off a Function the program overwrote yields
 * that object's own dynamic property table, not the `Function.prototype`
 * method `lib.es5.d.ts` types the read as, and the carrier has to say so
 * before any plan exists. A write whose target object is unknown is absent
 * here and present in `anonymousProperties` below; that asymmetry is the
 * whole reason the two views are separate, and it is why this one is a
 * SUBSET -- never a superset -- of what the certify stage refuses on.
 */
const callableOwnWritesByGraph = new WeakMap<SemanticGraph, ReadonlyMap<FunctionId, ReadonlySet<string>>>()

export const callableOwnPropertyWritesOf = (
  graph: SemanticGraph,
  origins: ReadonlyMap<SemanticResultId, FunctionId> = callableOriginsOf(graph)
): ReadonlyMap<FunctionId, ReadonlySet<string>> => {
  const known = callableOwnWritesByGraph.get(graph)
  if (known) return known
  const writes = new Map<FunctionId, Set<string>>()
  const prototypeOrigins = functionPrototypeOriginsOf(graph)
  for (const target of callableWriteTargetsOf(graph)) {
    if (prototypeOrigins.has(target.result)) continue
    const origin = origins.get(target.result)
    if (origin === undefined) continue
    const bucket = writes.get(origin)
    if (bucket) bucket.add(target.name)
    else writes.set(origin, new Set([target.name]))
  }
  callableOwnWritesByGraph.set(graph, writes)
  return writes
}

const callableMutationFactsByPlan = new WeakMap<SealedRepresentationPlan, CallableMutationFacts>()

const canCarryCallableObject = (plan: SealedRepresentationPlan, result: SemanticResultId): boolean => {
  const representation = plan.selected.get(result)
  if (representation === undefined) return false
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'function-and-constructor':
    case 'generic-function-set':
    case 'dynamic':
      return true
    default:
      return false
  }
}

/**
 * Own-property mutations grouped by the exact Function object they target.
 *
 * This deliberately records more than writes that dominate a particular
 * read: absence from the whole-program set is the proof a static
 * `Function.prototype.call`/`apply` rewrite needs. A write in an exclusive or
 * later branch may conservatively keep the ordinary property call, but can
 * never be skipped as if it did not exist.
 */
export const callableMutationFactsOf = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  origins: ReadonlyMap<SemanticResultId, FunctionId> = callableOriginsOf(graph)
): CallableMutationFacts => {
  const known = callableMutationFactsByPlan.get(plan)
  if (known) return known
  const anonymousWrites = new Set<string>()
  const prototypeWrites = new Set<string>()
  const prototypeOrigins = functionPrototypeOriginsOf(graph)
  for (const target of callableWriteTargetsOf(graph)) {
    if (prototypeOrigins.has(target.result)) {
      prototypeWrites.add(target.name)
      continue
    }
    if (origins.get(target.result) !== undefined) continue
    if (canCarryCallableObject(plan, target.result)) anonymousWrites.add(target.name)
  }
  const facts: CallableMutationFacts = {
    ownProperties: callableOwnPropertyWritesOf(graph, origins),
    anonymousProperties: anonymousWrites,
    functionPrototypeProperties: prototypeWrites
  }
  callableMutationFactsByPlan.set(plan, facts)
  return facts
}

/** One shared proof used by preflight and IR lowering before skipping [[Get]]. */
export const callableBuiltinResolution = (
  facts: CallableMutationFacts,
  functionId: FunctionId | null,
  member: 'call' | 'apply' | 'bind'
): 'builtin' | 'ordinary-property' | 'prototype-mutated' => {
  const prototype = facts.functionPrototypeProperties
  if (prototype.has(member) || prototype.has(unknownCallableOwnProperty)) return 'prototype-mutated'
  const unknown = facts.anonymousProperties
  if (unknown.has(member) || unknown.has(unknownCallableOwnProperty)) return 'ordinary-property'
  const own = functionId === null ? undefined : facts.ownProperties.get(functionId)
  if (own?.has(member) || own?.has(unknownCallableOwnProperty)) return 'ordinary-property'
  return 'builtin'
}

export const callableBuiltinIsUnshadowed = (
  facts: CallableMutationFacts,
  functionId: FunctionId | null,
  member: 'call' | 'apply' | 'bind'
): boolean => callableBuiltinResolution(facts, functionId, member) === 'builtin'
