import type { RecordIndexSidecar, Representation } from '../../representation/model.js'
import type { DeclarationId } from '../../identity/ids.js'
import { withoutSpecialization } from '../../identity/ids.js'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import type { SemanticGraph } from '../../semantics/model/graph.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'
import { callableBuiltinResolution, callableMutationFactsOf, callableOriginsOf } from '../../semantics/callable-origins.js'

/**
 * The receiver-side vocabulary of the `property-access` capability family:
 * which carrier an access reads through, and the per-site refinements a flat
 * manifest claim cannot express on its own (`record-with-index` field-vs-
 * sidecar, `native-record-ref` index sidecar, callable builtin members,
 * `constructor-family` census). `ir/certify/property-access.ts` spells the
 * demands; this module answers the questions each spelling depends on.
 *
 * Moved from `preflight/property-access.ts` when the plan-side obligation builder that
 * used to sit beside these was deleted: the questions survived the builder
 * because they are about representations, not about the plan's edges.
 */

/**
 * Whether the receiver this access reads through has a semantic type that is
 * `never` -- so the access is on a branch flow analysis proved unreachable.
 *
 * The same fact `deadTypeofGuards.isDeadOperation` states for one specific
 * source of dead code, asked generally. mongodb's `execute_operation.ts:198`
 * is the case that needed it: `tryOperation<T extends AbstractOperation>`
 * narrows `operation` with `instanceof AggregateOperation`, monomorphization
 * mints one copy per concrete `T`, and in every copy whose `T` is a DIFFERENT
 * operation class the narrowed type is two unrelated classes intersected --
 * uninhabited, so nothing is ever read there (`derive.ts`'s
 * `isUninhabitedNominalIntersection`). Asking for a property recipe anyway
 * reported a gap for a load the program never performs.
 *
 * The SEMANTIC type, not the carrier: `never` and a genuine `undefined` share
 * one carrier (`representation/primitives.ts` gives both no storage) and only
 * one of them is unreachable -- the identical distinction
 * `buildBindingReadObligations` states for its own `never` skip.
 */
export const receiverIsUnreachable = (graph: SemanticGraph, operation: SemanticOperation, deriver: RepresentationDeriver): boolean =>
  ['receiver', 'base'].some((role) => {
    const receiver = operandOf(operation, role)
    if (!receiver || receiver.source.kind !== 'result') return false
    const resultId = receiver.source.result
    const producerId = graph.results.get(resultId)
    const producer = producerId === undefined ? undefined : graph.operations.get(producerId)
    const published = producer?.results.find((candidate) => candidate.id === resultId)
    return published !== undefined && deriver.isNeverType(published.type)
  })

/**
 * Every class declaration `class-lifecycle` published at least one event for.
 *
 * `constructor-family`'s emitter (`emit-properties.ts`'s
 * `classConstructorStaticMemberText`) resolves a static member by walking
 * the `ClassLayout` `projectClasses` builds from these same events -- and an
 * ambient `declare class` (an Apple/ObjC or three.js binding shipped as a
 * `.d.ts`, e.g. `UIColor`) publishes none, because `semantics/program.ts`
 * deliberately keeps declaration files out of the census
 * (`!file.isDeclarationFile`). A flat manifest claim cannot see that
 * distinction -- it only knows the carrier kind, not which class -- so a
 * `constructor-family` receiver's obligation is additionally checked here,
 * per declaration, against the set this computes once per compile. Without
 * it, claiming the recipe generically would certify a program whose
 * `UIColor.whiteColor` site can never actually resolve, discovering the gap
 * only at emission instead of at preflight -- the exact "manifest claims
 * more than the emitter can render" failure this census exists to prevent.
 */
export const classDeclarationsWithLifecycleEvents = (graph: SemanticGraph): ReadonlySet<DeclarationId> => {
  const declarations = new Set<DeclarationId>()
  // A generic class's lifecycle events name the monomorphized COPY
  // (`decl|f168|1@0`) while its constructor-family carrier names the
  // declaration itself (`decl|f168|1`): one class, two spellings. Both are
  // recorded, so `IdentifierNameMap.toKey(...)` on a generic class reads as
  // censused -- measured on tsc's `transformers/utilities.ts`, where every
  // static call on a generic class was refused `constructor-family
  // (uncensused)` for exactly this.
  const record = (declaration: DeclarationId): void => {
    declarations.add(declaration)
    declarations.add(withoutSpecialization(declaration))
  }
  for (const operation of graph.operations.values()) {
    if (operation.family === 'class-lifecycle') record(operation.classDeclaration)
    // A memberless class expression (`const E = class {}`) publishes no
    // lifecycle event, but its constructor-object allocation names the class
    // it evaluated -- the same census, stated by the one event it does have.
    if (
      operation.family === 'allocation' &&
      operation.allocated === 'class-constructor-object' &&
      operation.classDeclaration !== undefined
    ) {
      record(operation.classDeclaration)
    }
  }
  return declarations
}

/**
 * Whether a `native-record-ref` receiver's named shape derives an index
 * sidecar, licensing a computed `get` to route into it. Unlike
 * `record-with-index`, whose every instance *by construction* has one,
 * `native-record-ref` only names a shape by id -- it can equally well name
 * an ordinary interface with none, so an unconditional claim would
 * over-claim. Checked per site, like `recordWithIndexKeyNamesAField` and
 * `constructorFamilyIsCensused`. Asks the deriver directly rather than
 * going through `targets/cpp/records.ts`, which preflight must stay
 * agnostic of.
 */
export const nativeRecordRefHasIndexSidecar = (representation: Representation | undefined, deriver: RepresentationDeriver): boolean => {
  if (representation?.kind !== 'native-record-ref') return false
  return deriver.layoutOf(representation.shapeId as StructuralTypeId).kind === 'record-with-index'
}

export const recordIndexesOf = (
  representation: Representation | undefined,
  deriver: RepresentationDeriver
): readonly RecordIndexSidecar[] => {
  if (representation?.kind === 'record-with-index') return representation.indexes
  if (representation?.kind !== 'native-record-ref' || representation.native !== null) return []
  const layout = deriver.layoutOf(representation.shapeId as StructuralTypeId)
  return layout.kind === 'record-with-index' ? layout.indexes : []
}

/**
 * Whether every arm of a `tagged-union` receiver is a typed array.
 *
 * The mirror of `recordWithIndexKeyNamesAField` and
 * `nativeRecordRefHasIndexSidecar`: a per-site fact the flat manifest cannot
 * state, except that this one WIDENS what is claimed rather than narrowing
 * it. `manifest/capabilities.ts` withholds `tagged-union:get:true` because a
 * per-arm dispatch of a runtime-only key would have to reconcile
 * `array-object`- and `dictionary`-shaped arms; a union whose every arm is a
 * typed array owes no such reconciliation, because `TypedArray::elementAt`
 * answers `double` for all eight element domains. `TypedArray` -- nine views
 * that differ only in element width -- is exactly that shape, and it is why
 * `array[ i ]` on a `BufferAttribute`'s array had no recipe.
 */
export const taggedUnionArmsAreAllTypedArrays = (representation: Representation | undefined): boolean => {
  if (representation?.kind !== 'tagged-union') return false
  return representation.arms.every((arm) => arm.value.kind === 'typed-array')
}

/**
 * Whether every arm of a `tagged-union` receiver is a `dictionary` -- the
 * second shape (besides "every arm a typed array") a COMPUTED `get` owes no
 * per-arm-KIND reconciliation for, only the ordinary per-arm VALUE
 * reconciliation `emit-union-properties.ts`'s `dictionaryArmReadText`
 * already performs. `Record<string, number> | Record<string, string>`
 * (hono's route param table, narrowed vs. unresolved) and
 * `Record<string, string> | Record<string, string[]>` (its query-string
 * result, single vs. multi-value) are both this.
 */
export const taggedUnionArmsAreAllDictionaries = (representation: Representation | undefined): boolean => {
  if (representation?.kind !== 'tagged-union') return false
  return representation.arms.every((arm) => arm.value.kind === 'dictionary')
}

/**
 * Whether every arm of a `tagged-union` receiver is an `array-object` -- the
 * third shape (besides "every arm a typed array" and "every arm a
 * dictionary") a COMPUTED `get` owes no per-arm-KIND reconciliation for, only
 * the ordinary per-arm VALUE reconciliation `emit-union-properties.ts`'s
 * `arrayArmReadText` already performs. `[T, ParamIndexMap][] | [T, Params][]`
 * (hono's router match result's first slot, indexed by `routeIndex`) is
 * exactly this.
 */
export const taggedUnionArmsAreAllArrayObjects = (representation: Representation | undefined): boolean => {
  if (representation?.kind !== 'tagged-union') return false
  return representation.arms.every((arm) => arm.value.kind === 'array-object')
}

/**
 * Whether every live arm can perform a computed ordinary-property lookup
 * through an existing native sidecar.
 *
 * This is deliberately narrower than "every arm is an object". A native
 * sidecar is identity-keyed, so a by-value record has nowhere stable to keep
 * an expando; a host-native record may also expose members only through its
 * host protocol. The admitted generated records and classes already render
 * their fixed fields, typed index entries, and expando table through
 * `nativeDynamicGet`; a dynamic arm owns the same operation outright.
 */
export const taggedUnionArmsHaveNativeSidecar = (representation: Representation | undefined): boolean => {
  const answers = (value: Representation): boolean => {
    if (value.kind === 'tagged-union') return value.arms.every((arm) => answers(arm.value))
    if (value.kind === 'optional') return answers(value.payload)
    if (value.kind === 'dynamic' || value.kind === 'null' || value.kind === 'undefined') return true
    if (value.kind === 'native-record-ref' && value.native !== null) return false
    return (
      (value.kind === 'record' || value.kind === 'record-with-index' || value.kind === 'native-record-ref' || value.kind === 'class-ref') &&
      value.ownership === 'shared-refcount'
    )
  }
  return representation?.kind === 'tagged-union' && representation.arms.every((arm) => answers(arm.value))
}

/**
 * Whether a native callable carrier's non-computed `get` names
 * `Function.prototype.call`.
 *
 * A flat manifest claim cannot say WHICH member name a site reads, only that
 * a `function-value-dispatch:get:false` recipe exists somewhere -- the same
 * gap `constructorFamilyIsCensused` and its siblings above answer for their
 * own receivers. Unrefined, claiming the bare kind would certify `.name`,
 * `.length`, `.prototype`, `.apply`/`.bind` and every other
 * `Function.prototype` member equally, none of which
 * `ir/lower-invocation.ts`'s `deferredFunctionCallCalleeOf` -- the only place
 * a claim under this key is ever actually redeemed -- recognizes: it rewrites
 * the *invocation* that reads `.call` to call the underlying receiver
 * directly, with the read's own value never materialized, so there is no
 * recipe here for any OTHER member to fall back on.
 */

/** A Function builtin member is deferred only when every use immediately invokes that exact read. */
export const isDirectCallableBuiltinRead = (
  graph: SemanticGraph,
  operation: SemanticOperation,
  member: 'call' | 'apply' | 'bind'
): boolean => {
  if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) return false
  const key = operandOf(operation, 'key')
  if (key?.source.kind !== 'constant' || key.source.text !== member) return false
  const result = operation.results.find((candidate) => candidate.role === 'value')
  if (!result) return false
  let calls = 0
  for (const edge of graph.edges) {
    if (edge.kind !== 'value' || edge.result !== result.id) continue
    const user = graph.operations.get(edge.to)
    if (edge.role !== 'callee' || user?.family !== 'invocation' || user.internalMethod !== 'call' || user.optionalChain) return false
    if (member === 'bind' && user.operands.some((operand) => operand.role === 'spread-argument')) return false
    calls++
  }
  return calls > 0
}

/**
 * The direct native bind lowering is valid only while no admitted callable
 * write can shadow Function.prototype.bind with an own property. Redefining
 * `name` or `length` is valid and no longer belongs in this proof:
 * `bindCallable` snapshots those properties from the target's shared Function
 * identity through ordinary [[Get]]. This remains deliberately whole-program
 * and fail-closed for the one mutation that changes WHICH function is called.
 */
export const callableBuiltinResolutionAt = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  operation: SemanticOperation,
  member: 'call' | 'apply' | 'bind'
): ReturnType<typeof callableBuiltinResolution> | null => {
  const receiver = operandOf(operation, 'receiver')
  if (receiver?.source.kind !== 'result') return null
  const origins = callableOriginsOf(graph)
  const facts = callableMutationFactsOf(graph, plan, origins)
  return callableBuiltinResolution(facts, origins.get(receiver.source.result) ?? null, member)
}

export const callableBuiltinRecipeKey = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  operation: SemanticOperation,
  access: { readonly receiver: string; readonly method: string; readonly computed: boolean }
): string | null => {
  if (access.method !== 'get' || access.computed) return null
  const key = operandOf(operation, 'key')
  if (key?.source.kind !== 'constant') return null
  const member = key.source.text
  if (member !== 'call' && member !== 'apply' && member !== 'bind') return null
  const callableReceivers = new Set([
    'function',
    'function-family',
    'function-value-family',
    'function-value-dispatch',
    'function-and-constructor'
  ])
  if (!callableReceivers.has(access.receiver)) return null
  const resolution = callableBuiltinResolutionAt(graph, plan, operation, member)
  if (resolution === null || resolution === 'prototype-mutated') return null
  if (resolution === 'ordinary-property') return `${access.receiver}(prototype-dynamic)`
  if (!isDirectCallableBuiltinRead(graph, operation, member)) return `${access.receiver}(prototype-dynamic)`
  if (member === 'bind' && access.receiver === 'function-and-constructor') return null
  return `${access.receiver}(${member === 'bind' ? 'bind-direct' : member})`
}

/**
 * A callable's ordinary own-property write.
 *
 * The callable carrier keeps its invocation ABI, while its stable function
 * identity owns a separate dynamic-property table.  Unlike the named reads
 * above, assignment does not need a member-name refinement: every key either
 * updates an existing writable own property or creates an ordinary expando in
 * that one table.
 */
export const functionValueOwnPropertyWrite = (access: { readonly method: string; readonly computed: boolean }): boolean => {
  return access.method === 'set' && !access.computed
}

/**
 * The Function names a native callable may NOT mistake for an ordinary own
 * expando. Each has either a separate implementation (`call`, `apply`, direct
 * `toString`) or no implementation at all (`bind`, legacy poison pills, and
 * `constructor`); admitting one through a sidecar would turn an unsupported
 * Function-prototype operation into a plausible `undefined` read.
 */
export const nonExpandoFunctionMemberNames = new Set(['call', 'apply', 'bind', 'toString', 'constructor', 'caller', 'arguments'])
