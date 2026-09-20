import type { SemanticResultId } from '../identity/ids.js'
import {
  dynamicReasons,
  recursiveCarrierOf,
  representationKey,
  walkRepresentation as walk,
  type RecursiveCarrier,
  type Representation
} from './model.js'
import type { SealedRepresentationPlan } from './plan.js'

/**
 * Fail-closed guards over a sealed plan.
 *
 * A guard firing here is always correct: the defect is in whatever produced the
 * inconsistent plan. These are deliberately not warnings and deliberately not
 * relaxable, because every one of them describes a state that compiles into a
 * silently wrong program rather than a loud failure.
 */

export interface RepresentationViolation {
  readonly guard: string
  readonly result: SemanticResultId | null
  readonly message: string
}

/**
 * `unresolved` is lattice bottom. Reaching materialization with it means a
 * carrier was never selected, and materializing anyway yields a default-
 * constructed slot -- `undefined` where a value was meant to be.
 */
/**
 * Every carrier reachable from any selection, once per carrier OBJECT, with
 * the first result whose selection reached it.
 *
 * The guards below ask per-node questions, and a node shared between
 * selections -- the derive memo hands every reader of one structural type the
 * same object -- has one answer. Walking each selection's own tree in full
 * asked it once per path instead: on the tsc self-compile, union carriers
 * whose arms embed records whose fields embed unions made that walk 80% of
 * a representations stage that was still running after twenty minutes
 * (preflight15, profiled in place), for a plan whose distinct carriers number
 * in the tens of thousands. One DAG walk per plan, shared by every guard.
 */
const carriersByPlan = new WeakMap<SealedRepresentationPlan, ReadonlyMap<Representation, SemanticResultId>>()
const reachableCarriers = (plan: SealedRepresentationPlan): ReadonlyMap<Representation, SemanticResultId> => {
  const remembered = carriersByPlan.get(plan)
  if (remembered) return remembered
  const visited = new Set<Representation>()
  const reached = new Map<Representation, SemanticResultId>()
  for (const [result, representation] of plan.selected) {
    for (const found of walk(representation, visited)) reached.set(found, result)
  }
  carriersByPlan.set(plan, reached)
  return reached
}

const unresolvedGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  for (const [found, result] of reachableCarriers(plan)) {
    if (found.kind !== 'unresolved') continue
    violations.push({
      guard: 'unresolved-reaches-materialization',
      result,
      message: `result ${result} selected a carrier containing unresolved(${found.reason})`
    })
  }
  return violations
}

/**
 * The boxing guard.
 *
 * `dynamic` is legitimate at exactly four boundaries. Any other appearance is a
 * statically typed value that lost its type, which is the defect this compiler
 * exists to not have.
 */
const boxingGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  const permitted = new Set<string>(dynamicReasons)
  for (const [found, result] of reachableCarriers(plan)) {
    if (found.kind !== 'dynamic') continue
    if (permitted.has(found.reason)) continue
    violations.push({
      guard: 'boxed-without-declared-reason',
      result,
      message: `result ${result} selected dynamic carrier with undeclared reason "${found.reason}"`
    })
  }
  return violations
}

/**
 * One JavaScript-observable Array must not be an `array-object` at one endpoint
 * and a bare buffer at another. A dense buffer has no hole semantics, no index
 * key domain, and no `length` rules, so publishing one where an Array is
 * observable loses behavior that the program can see.
 */
const arrayCarrierSplitGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  for (const [found, result] of reachableCarriers(plan)) {
    if (found.kind !== 'dense-buffer') continue
    violations.push({
      guard: 'dense-buffer-in-observable-position',
      result,
      message:
        `result ${result} selected dense-buffer(${representationKey(found.element)}); ` +
        'a dense buffer is compiler-private storage and is never a published semantic result'
    })
  }
  return violations
}

/**
 * A proxy carries target, handler, and revoked state. A target-only carrier
 * cannot perform trap lookup, so every operation on it silently becomes an
 * operation on the target -- the traps stop running and nothing reports it.
 */
const proxyCompletenessGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  for (const [found, result] of reachableCarriers(plan)) {
    if (found.kind !== 'proxy-object') continue
    if (found.handler.kind !== 'unresolved') continue
    violations.push({
      guard: 'proxy-without-handler',
      result,
      message: `result ${result} selected a proxy carrier whose handler is unresolved`
    })
  }
  return violations
}

/** A tagged union must name its arms uniquely; duplicates resolve by position. */
const taggedUnionGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  for (const [found, result] of reachableCarriers(plan)) {
    if (found.kind !== 'tagged-union') continue
    const tags = found.arms.map((arm) => arm.tag)
    if (new Set(tags).size === tags.length) continue
    violations.push({
      guard: 'tagged-union-duplicate-tag',
      result,
      message: `result ${result} selected a tagged union with duplicate arm tags: ${tags.join(', ')}`
    })
  }
  return violations
}

/** The one carrier kind a fixpoint of this container may be published as. */
const recursiveCarrierKindOf = (container: RecursiveCarrier['container']): Representation['kind'] =>
  container === 'callable' ? 'function-value-dispatch' : container

/**
 * The one ownership a fixpoint of this container may be published with.
 *
 * A container's wrapper IS a heap object reached through a pointer, so both
 * halves of its equation must be refcounted or the back edge would embed the
 * definition by value. A callable wrapper is the opposite: `gea::CallableObject`
 * stores a pointer and a capture, never its parameter types, so the struct is
 * held by value and a refcount would be a second, unshared identity.
 */
const recursiveOwnershipOf = (container: RecursiveCarrier['container']): string => (container === 'callable' ? 'owned' : 'shared-refcount')

/**
 * A recursive native carrier is one named wrapper plus one or more typed
 * references to it. The reference is intentionally a `native-record-ref`
 * leaf, so this checks the equation by its sealed structural identity rather
 * than trying to rediscover it by expanding a graph edge.
 */
const recursiveCarrierGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] => {
  const violations: RepresentationViolation[] = []
  const definitions = new Map<string, { readonly container: string; readonly ownership: string }>()
  const references: { readonly carrier: Representation; readonly result: SemanticResultId }[] = []
  for (const [carrier, result] of reachableCarriers(plan)) {
    const recursive = recursiveCarrierOf(carrier)
    if (!recursive) continue
    if (recursive.role === 'definition') {
      const published =
        carrier.kind === 'function-value-dispatch'
          ? 'owned'
          : carrier.kind === 'array-object' || carrier.kind === 'keyed-collection' || carrier.kind === 'dictionary'
            ? carrier.ownership
            : null
      if (
        published === null ||
        carrier.kind !== recursiveCarrierKindOf(recursive.container) ||
        published !== recursiveOwnershipOf(recursive.container)
      ) {
        violations.push({
          guard: 'recursive-native-carrier-definition',
          result,
          message: `result ${result} publishes malformed recursive native definition ${recursive.type}`
        })
        continue
      }
      const existing = definitions.get(recursive.type)
      if (existing && (existing.container !== recursive.container || existing.ownership !== published)) {
        violations.push({
          guard: 'recursive-native-carrier-definition',
          result,
          message: `recursive native definition ${recursive.type} disagrees about its container or ownership`
        })
        continue
      }
      definitions.set(recursive.type, { container: recursive.container, ownership: published })
      continue
    }
    references.push({ carrier, result })
  }
  for (const { carrier, result } of references) {
    const recursive = recursiveCarrierOf(carrier)
    if (!recursive) continue
    const definition = definitions.get(recursive.type)
    const privateMarker = `recursive-container:${recursive.type}`
    if (
      carrier.kind !== 'native-record-ref' ||
      carrier.native !== privateMarker ||
      carrier.ownership !== recursiveOwnershipOf(recursive.container) ||
      !definition ||
      definition.container !== recursive.container ||
      definition.ownership !== carrier.ownership
    ) {
      violations.push({
        guard: 'recursive-native-carrier-reference',
        result,
        message: `result ${result} publishes recursive reference ${recursive.type} without its matching native wrapper definition`
      })
    }
  }
  return violations
}

/** An uncommitted conflict must never be observable as a selection. */
const conflictGuard = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] =>
  plan.conflicts.map((conflict) => ({
    guard: 'unresolved-representation-conflict',
    result: conflict.result,
    message:
      `result ${conflict.result} in component ${conflict.component} has conflicting exact carriers: ` +
      `${conflict.left.producer} published ${representationKey(conflict.left.representation)} while ` +
      `${conflict.right.producer} published ${representationKey(conflict.right.representation)}`
  }))

/** Run every guard and return the complete violation set, never just the first. */
export const verifyRepresentationPlan = (plan: SealedRepresentationPlan): readonly RepresentationViolation[] =>
  [
    ...conflictGuard(plan),
    ...unresolvedGuard(plan),
    ...boxingGuard(plan),
    ...arrayCarrierSplitGuard(plan),
    ...proxyCompletenessGuard(plan),
    ...taggedUnionGuard(plan),
    ...recursiveCarrierGuard(plan)
  ].sort((left, right) =>
    left.guard === right.guard ? String(left.result).localeCompare(String(right.result)) : left.guard.localeCompare(right.guard)
  )
