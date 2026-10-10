import type { DeclarationId, FunctionId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from './model/graph.js'
import { identityOperandOf, operandOf, resultOf, type SemanticOperand, type SemanticResult } from './model/operands.js'
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
      // Identity operations preserve the exact Function object. In particular,
      // the assignment computation preserves its RHS while a property store
      // preserves its receiver; those are different semantic results.
      if (operation.family !== 'binding') {
        const source = identityOperandOf(operation)?.source
        const stored = source?.kind === 'result' ? origins.get(source.result) : undefined
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

/** The declaration's actual MakeConstructor fact, independent of its call ABI. */
export const callableOwnPrototypeOf = (graph: SemanticGraph, source: FunctionId): boolean | null =>
  ownPrototypeFactsOf(graph).get(source) ?? null

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
  return callableOwnPrototypeOf(graph, origin)
}

/** A computed key can overwrite either explicit-this builtin. */
export const unknownCallableOwnProperty = '*'

export interface CallableMutationFacts {
  readonly ownProperties: ReadonlyMap<FunctionId, ReadonlySet<string>>
  /** Writes through a callable value whose exact Function object is unknown. */
  readonly anonymousProperties: ReadonlySet<string>
  /**
   * The subset of `anonymousProperties` written ONLY through a boxed target
   * (`dynamic`, most often a parameter typed `any`), never through a callable
   * carrier. Such a write reaches a Function object only if that object was
   * boxed somewhere, which a whole-program `anonymousProperties` cannot tell
   * apart -- see `callableBindResolution`.
   */
  readonly boxedOnlyProperties: ReadonlySet<string>
  readonly functionPrototypeProperties: ReadonlySet<string>
}

const propertyNameOf = (operation: SemanticOperation, role: string, ordinal = 0): string => {
  const key = operandOf(operation, role, ordinal)
  return key?.source.kind === 'constant' && key.source.literal === 'string' ? key.source.text : unknownCallableOwnProperty
}

/** Semantic results proven to carry the one global Function.prototype object. */
const functionPrototypeOriginsByGraph = new WeakMap<SemanticGraph, ReadonlySet<SemanticResultId>>()

export const functionPrototypeOriginsOf = (graph: SemanticGraph): ReadonlySet<SemanticResultId> => {
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
      if (operation.family !== 'binding') {
        const target = identityOperandOf(operation)
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
/** Exact semantic mutation inventory shared by builtin resolution and native own storage.
 * @semanticCategory generic-primitive
 */
export interface CallableWriteTarget {
  readonly result: SemanticResultId | null
  readonly name: string
  /** Null is an unknown property domain; the literal key '*' remains an ordinary exact key. */
  readonly key: string | null
  readonly operation: SemanticOperation
  /** Reflect.set consults this target's property protocol before writing its Receiver. */
  readonly lookupTarget: SemanticOperand | null
  readonly target: SemanticOperand
  readonly value: SemanticOperand | null
  readonly produced: SemanticResult | null
  readonly kind:
    | 'set'
    | 'delete'
    | 'reflect-delete'
    | 'define-own-property'
    | NonNullable<Extract<SemanticOperation, { family: 'invocation' }>['intrinsicMutation']>
  readonly resultContract: 'receiver' | 'boolean' | 'none'
  /** A bulk store reads the current source slot; it does not evaluate an
   * initializer again or use the public intersection as its RHS carrier. */
  readonly copiedSlot?: {
    readonly ordinal: number
    readonly source: SemanticOperand
    readonly roots: readonly import('./native-own-assignment.js').NativeOwnAssignment['sources'][number]['roots'][number][]
    readonly values: readonly import('./native-own-assignment.js').NativeOwnAssignmentValue[]
    /** The slot is the described source carrier's own field of this key, not a closed value family. */
    readonly described?: true
  }
}

const callableWriteTargetsByGraph = new WeakMap<SemanticGraph, readonly CallableWriteTarget[]>()

export const callableWriteTargetsOf = (graph: SemanticGraph): readonly CallableWriteTarget[] => {
  const known = callableWriteTargetsByGraph.get(graph)
  if (known) return known
  const targets: CallableWriteTarget[] = []
  for (const operation of graph.operations.values()) {
    if (operation.family === 'property') {
      if (operation.internalMethod !== 'set' && operation.internalMethod !== 'delete' && operation.internalMethod !== 'define-own-property')
        continue
      const receiver = operandOf(operation, 'receiver')
      if (receiver === undefined) continue
      const key = operandOf(operation, 'key')
      const text = key?.source.kind === 'constant' && key.source.literal === 'string' ? key.source.text : null
      const names = text === null && operation.provenKeyTexts?.length ? operation.provenKeyTexts : [text]
      for (const name of names)
        targets.push({
          result: receiver.source.kind === 'result' ? receiver.source.result : null,
          name: name ?? propertyNameOf(operation, 'key'),
          key: name,
          operation,
          lookupTarget: null,
          target: receiver,
          value: operandOf(operation, 'value') ?? null,
          produced: resultOf(operation, 'value') ?? null,
          kind: operation.internalMethod,
          resultContract: operation.internalMethod === 'delete' ? 'boolean' : 'receiver'
        })
      continue
    }
    if (
      operation.family !== 'invocation' ||
      (operation.intrinsicMutation === undefined && operation.intrinsicReflection !== 'deleteProperty')
    )
      continue
    const lookupTarget = operandOf(operation, 'argument', 0)
    if (lookupTarget === undefined) continue
    if (operation.intrinsicMutation === 'object-assign' && operation.nativeOwnAssignment !== undefined) {
      for (const source of operation.nativeOwnAssignment.sources) {
        const operand = operandOf(operation, 'argument', source.ordinal)
        if (operand === undefined) continue
        const keys = new Set([...source.roots.flatMap((root) => root.slots.map((slot) => slot.key)), ...(source.described?.keys ?? [])])
        for (const key of keys) {
          const values = source.roots.flatMap((root) => root.slots.filter((slot) => slot.key === key).flatMap((slot) => slot.values))
          targets.push({
            result: lookupTarget.source.kind === 'result' ? lookupTarget.source.result : null,
            name: key,
            key,
            operation,
            lookupTarget: null,
            target: lookupTarget,
            value: null,
            produced: resultOf(operation, 'value') ?? null,
            kind: 'object-assign',
            resultContract: 'receiver',
            copiedSlot: {
              ordinal: source.ordinal,
              source: operand,
              roots: source.roots,
              values,
              ...(source.described === undefined ? {} : { described: true as const })
            }
          })
        }
        // A described source also carries whatever keys its carrier holds at
        // run time beyond its declared members: the open, unknown-key write.
        if (source.described !== undefined)
          targets.push({
            result: lookupTarget.source.kind === 'result' ? lookupTarget.source.result : null,
            name: unknownCallableOwnProperty,
            key: null,
            operation,
            lookupTarget: null,
            target: lookupTarget,
            value: null,
            produced: resultOf(operation, 'value') ?? null,
            kind: 'object-assign',
            resultContract: 'receiver'
          })
      }
      continue
    }
    // Reflect.set dispatches target.[[Set]](key, value, Receiver). A distinct
    // Receiver receives the own data property; the lookup target does not.
    const target = operation.intrinsicMutation === 'reflect-set' ? (operandOf(operation, 'argument', 3) ?? lookupTarget) : lookupTarget
    const name =
      operation.intrinsicMutation === 'object-assign' || operation.intrinsicMutation === 'object-define-properties'
        ? unknownCallableOwnProperty
        : propertyNameOf(operation, 'argument', 1)
    const key = operandOf(operation, 'argument', 1)
    const text =
      operation.intrinsicMutation === 'object-assign' || operation.intrinsicMutation === 'object-define-properties'
        ? null
        : key?.source.kind === 'constant' && key.source.literal === 'string'
          ? key.source.text
          : null
    targets.push({
      result: target.source.kind === 'result' ? target.source.result : null,
      name,
      key: text,
      operation,
      lookupTarget: operation.intrinsicMutation === 'reflect-set' ? lookupTarget : null,
      target,
      value: operation.intrinsicMutation === 'reflect-set' ? (operandOf(operation, 'argument', 2) ?? null) : null,
      produced: resultOf(operation, 'value') ?? null,
      kind: operation.intrinsicMutation ?? 'reflect-delete',
      resultContract:
        operation.intrinsicMutation === 'reflect-set' || operation.intrinsicReflection === 'deleteProperty' ? 'boolean' : 'receiver'
    })
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
    if (target.result !== null && prototypeOrigins.has(target.result)) continue
    const origin = target.result === null ? undefined : origins.get(target.result)
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

/** Direct formals have no result-plan entry. Their structural source domain still cannot be omitted. */
export const callableWriteTargetCanCarryFunction = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  target: CallableWriteTarget
): boolean => {
  if (target.result !== null) return canCarryCallableObject(plan, target.result)
  if (target.target.asserted) return true
  const seen = new Set<StructuralTypeId>()
  const possible = (id: StructuralTypeId): boolean => {
    if (seen.has(id)) return true
    seen.add(id)
    const shape = graph.structuralTypes.get(id)?.shape
    if (shape === undefined) return true
    if (shape.kind === 'primitive') return shape.primitive === 'any' || shape.primitive === 'unknown'
    if (
      shape.kind === 'literal' ||
      shape.kind === 'unique-symbol' ||
      shape.kind === 'array' ||
      shape.kind === 'tuple' ||
      shape.kind === 'class-instance'
    )
      return false
    if (shape.kind === 'declared') return shape.body === null || possible(shape.body)
    if (shape.kind === 'object-anchor') return possible(shape.body)
    if (shape.kind === 'union' || shape.kind === 'intersection') return shape.members.some(possible)
    // Functions can satisfy structural object views; signatures, erased type
    // parameters and unresolved inputs are not a proof of disjoint identity.
    return true
  }
  return possible(target.target.type)
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
  const callableCarriedWrites = new Set<string>()
  const prototypeWrites = new Set<string>()
  const prototypeOrigins = functionPrototypeOriginsOf(graph)
  for (const target of callableWriteTargetsOf(graph)) {
    if (target.result !== null && prototypeOrigins.has(target.result)) {
      prototypeWrites.add(target.name)
      continue
    }
    if (target.result !== null && origins.get(target.result) !== undefined) continue
    if (!callableWriteTargetCanCarryFunction(graph, plan, target)) continue
    anonymousWrites.add(target.name)
    if (target.result === null || plan.selected.get(target.result)?.kind !== 'dynamic') callableCarriedWrites.add(target.name)
  }
  const facts: CallableMutationFacts = {
    ownProperties: callableOwnPropertyWritesOf(graph, origins),
    anonymousProperties: anonymousWrites,
    boxedOnlyProperties: new Set([...anonymousWrites].filter((name) => !callableCarriedWrites.has(name))),
    functionPrototypeProperties: prototypeWrites
  }
  // `GEA_CALLABLE_FACTS_DEBUG`: the whole-program verdict every `.call`/
  // `.apply`/`.bind` rewrite is gated on, with the write that produced each
  // anonymous entry -- one `target[k] = v` through a carrier that can hold a
  // Function object is enough to turn every unknown-origin `.call` in the
  // program into an ordinary property read, and nothing else names it.
  if (process.env.GEA_CALLABLE_FACTS_DEBUG) {
    const describe = (target: CallableWriteTarget): string => {
      const producer = target.result === null ? undefined : graph.results.get(target.result)
      const operation = producer === undefined ? undefined : graph.operations.get(producer)
      return `${target.name} <- ${operation?.family ?? '?'}:${producer ?? '?'} carried ${target.result === null ? target.target.source.kind : (plan.selected.get(target.result)?.kind ?? '?')}`
    }
    const anonymous = callableWriteTargetsOf(graph).filter(
      (target) =>
        (target.result === null || (origins.get(target.result) === undefined && !prototypeOrigins.has(target.result))) &&
        callableWriteTargetCanCarryFunction(graph, plan, target)
    )
    console.error(
      `[callable-facts] anonymous=${JSON.stringify([...anonymousWrites])} boxedOnly=${JSON.stringify([...facts.boxedOnlyProperties])} ` +
        `prototype=${JSON.stringify([...prototypeWrites])} own=${facts.ownProperties.size}`
    )
    for (const target of anonymous) console.error(`[callable-facts]   ${describe(target)}`)
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

/**
 * `callableBuiltinResolution` for `bind` on one KNOWN Function object, with
 * the one case it cannot decide split out: `'builtin-unless-boxed'` when the
 * only writes that could shadow `bind` go through boxed targets.
 *
 * Such a write (`target[key] = value` on a `target: any`) reaches this
 * Function object only if the object itself was boxed somewhere -- read as a
 * value into a dynamic carrier, or reached through a boxed instance, prototype
 * or constructor of the class that declares it. Whether that happens is a
 * fact about the lowered program, not the semantic graph, so the answer is an
 * ASSUMPTION the caller stamps on its lowering and the reflection census
 * confirms or refutes (`ir/boxed-bind-assumptions.ts`). A write through a
 * callable carrier, or through this function's own name, stays decisive.
 */
export const callableBindResolution = (
  facts: CallableMutationFacts,
  functionId: FunctionId | null
): ReturnType<typeof callableBuiltinResolution> | 'builtin-unless-boxed' => {
  const resolution = callableBuiltinResolution(facts, functionId, 'bind')
  if (resolution !== 'ordinary-property') return resolution
  // An unknown origin (a read through an interface union:
  // `router.match.bind(router)`) could be any function, so a statically named
  // own `bind` anywhere stays decisive for it.
  const owns = functionId === null ? [...facts.ownProperties.values()] : [facts.ownProperties.get(functionId)]
  if (owns.some((own) => own?.has('bind') || own?.has(unknownCallableOwnProperty))) return resolution
  const boxedOnly = (name: string): boolean => !facts.anonymousProperties.has(name) || facts.boxedOnlyProperties.has(name)
  return boxedOnly('bind') && boxedOnly(unknownCallableOwnProperty) ? 'builtin-unless-boxed' : resolution
}

/**
 * `callableBuiltinResolution` for `call`/`apply` on a callable the program
 * carries NATIVELY, with the same split `callableBindResolution` makes: when
 * every write that could shadow the member goes through a boxed target, the
 * answer is `'builtin-unless-boxed'`.
 *
 * Unlike `bind`, which the reflection census confirms per method, this needs
 * no known function: the assumption is checked at run time on the ONE Function
 * object the call reaches (`emit-callable.ts`'s shadow guard reads its
 * own-property table, the way `callableBindIsIntrinsic` does), so a callable
 * of unknown origin -- a host accessor read out of a property descriptor,
 * a cached `toStringTagGetter.call(value)` brand check --
 * still gets its direct call. A write through a callable carrier, or through
 * the function's own name, stays decisive.
 */
export const callableInvokeResolution = (
  facts: CallableMutationFacts,
  functionId: FunctionId | null,
  member: 'call' | 'apply'
): ReturnType<typeof callableBuiltinResolution> | 'builtin-unless-boxed' => {
  const resolution = callableBuiltinResolution(facts, functionId, member)
  if (resolution !== 'ordinary-property') return resolution
  const own = functionId === null ? undefined : facts.ownProperties.get(functionId)
  if (own?.has(member) || own?.has(unknownCallableOwnProperty)) return resolution
  const boxedOnly = (name: string): boolean => !facts.anonymousProperties.has(name) || facts.boxedOnlyProperties.has(name)
  return boxedOnly(member) && boxedOnly(unknownCallableOwnProperty) ? 'builtin-unless-boxed' : resolution
}

export const callableBuiltinIsUnshadowed = (
  facts: CallableMutationFacts,
  functionId: FunctionId | null,
  member: 'call' | 'apply' | 'bind'
): boolean => callableBuiltinResolution(facts, functionId, member) === 'builtin'
