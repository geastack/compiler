import type { DeclarationId, SemanticResultId, StructuralTypeId } from '../../identity/ids.js'
import { disjointNativeRecordIndexOf } from '../native-record-index.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import { recordIndexForKeyCarrier, representationKey, type RecordField, type Representation } from '../../representation/model.js'
import { hasNativeNumericIndexArms } from '../../representation/numeric-index.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import type { RepresentationEvidence, SealedRepresentationPlan } from '../../representation/plan.js'
import { classPrototypeMemberIsPresent, symbolKeyedMemberIsDeclared } from '../../projection/class-property-presence.js'
import { objectShapePrototypeMethods } from '../../projection/callee.js'
import type { SemanticGraph } from '../../semantics/model/graph.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'
import { callableOwnPrototypeAt } from '../../semantics/callable-origins.js'
import { isDirectFunctionSourceRead } from './function-source.js'
import {
  callableBuiltinRecipeKey,
  classDeclarationsWithLifecycleEvents,
  functionValueOwnPropertyWrite,
  nativeRecordRefHasIndexSidecar,
  nonExpandoFunctionMemberNames,
  receiverIsUnreachable,
  recordIndexesOf,
  taggedUnionArmsAreAllArrayObjects,
  taggedUnionArmsAreAllDictionaries,
  taggedUnionArmsAreAllTypedArrays,
  taggedUnionArmsHaveNativeSidecar
} from './property-access-keys.js'
import {
  generatedObjectCarrier,
  generatedSharedObjectCarrier,
  generatedSharedRecordCarrier,
  layoutAnswerSuffix,
  recordAnswerFor,
  resolvedLayoutOf
} from './has-property-key.js'
import { definitelyPrimitive, mapTestable } from './instanceof-key.js'
import { atomicsCallSupport } from '../../targets/cpp/host/atomics.js'
import { regexpRoleOf } from '../../targets/cpp/prototype/emit-prototype-regexp.js'
import { nativeRecordIndexHasPropertyOf } from '../native-record-index-transport.js'
import type { CapabilityDemand, CertifyContext } from '../certify.js'
import type {
  CallOperation,
  DefineOwnPropertyOperation,
  DeleteOperation,
  GetOperation,
  HasPropertyOperation,
  IrOperand,
  IrOperation,
  OwnPropertyKeysOperation,
  SetOperation
} from '../model.js'

/**
 * The `property-access`, `host-member-call` and (for `has-property`/
 * `instanceof`) `runtime-helper` families of `ir/certify.ts`, ported from
 * `preflight/property-access.ts`, `preflight/has-property-key.ts`,
 * `preflight/instanceof-key.ts` and `preflight/invocation-arguments.ts`'s
 * Atomics builder.
 *
 * The manifest's tables (`targets/cpp/manifest/capabilities.ts`) spell a
 * receiver's recipe with the SAME refinements the old builders computed from
 * the semantic graph and plan -- `record-with-index(unmatched-key)`,
 * `iterator(next)`, `function-value-dispatch(bind-direct)`, and the rest.
 * Dropping any one of those parenthetical refinements here would certify a
 * program the printer still refuses, because the manifest never claims the
 * unrefined, flatter key. So this module re-derives every refinement the old
 * builders derived, using the IR's own already-resolved fields wherever one
 * is available (`IrOperand.representation` needs no plan lookup: lowering
 * already narrowed a receiver's view and left a key's carrier raw, exactly
 * the two facts the old builders read off the plan) and falling back to the
 * semantic operation via `ctx.semanticOperationOf(operation.lineage)` only
 * for the handful of genuinely whole-program facts the IR does not carry
 * (a callable's `.call`/`.apply`/`.bind` mutation census, a class's
 * lifecycle census) -- exactly the two `CertifyContext`'s own doc comment
 * names as still graph-derived pending Phase 3.
 *
 * `property-value.ts` and `array-literal-elements.ts` need no port: both
 * obligations existed only to check that a `dynamic`-sourced value converts
 * into its receiver's declared field/element type, and on the IR that
 * conversion is an explicit `convert` op lowering already emits before the
 * store (`ir/lower-property.ts`'s `enterRequiredOperand` on both `set` and
 * `define-own-property`'s value operand, `ir/lower-allocation.ts`'s
 * `enterRequiredOperand` in both the array-object and tuple-record branches)
 * -- the spine's own conversion census in `ir/certify.ts` already certifies
 * it, so restating it here would be a second, redundant obligation.
 */

// ---------------------------------------------------------------------------
// Shared IR-level key helpers
// ---------------------------------------------------------------------------

/** The constant text a property-access key operand states, or `null` for a genuinely computed one. A key is a raw role: its representation is never converted, so this is the whole of what the old builders' `keyIsComputed`/`source.kind === 'constant'` pair asked. */
const constantKeyTextOf = (ctx: CertifyContext, key: IrOperand): string | null => {
  const definition = ctx.definitionOf(key.value)
  return definition?.kind === 'constant' ? definition.text : null
}

/** Property-access keys are always constant-folded to a `literal: 'string'` text at normalize time (`producers/properties.ts`'s `keyOf`), so "computed" is exactly "not a constant". */
const isComputedKey = (ctx: CertifyContext, key: IrOperand): boolean => ctx.definitionOf(key.value)?.kind !== 'constant'

interface Access {
  readonly receiver: string
  readonly method: string
  readonly computed: boolean
}

type AccessOperation = GetOperation | SetOperation | DeleteOperation | DefineOwnPropertyOperation | OwnPropertyKeysOperation

/** The six object internal methods' own key/receiver shape, uniform across the five that carry a key. `own-property-keys` has none, and is never actually reached (see below) but is handled the same trivial way. */
const receiverAndKeyOf = (operation: AccessOperation): { readonly receiver: IrOperand; readonly key: IrOperand | null } => {
  if (operation.kind === 'own-property-keys') return { receiver: operation.receiver, key: null }
  return { receiver: operation.receiver, key: operation.key }
}

// ---------------------------------------------------------------------------
// Per-site refinements the old builders derived from a semantic operand;
// restated here against the IR's own key text/representation instead of an
// `operandOf(operation, 'key')` lookup, since the operand model itself
// differs (no `SemanticOperand.source` tri-state to switch on).
// ---------------------------------------------------------------------------

const constructorFamilyIsCensused = (representation: Representation, censusedClasses: ReadonlySet<DeclarationId>): boolean =>
  representation.kind === 'constructor-family' && representation.members.some((member) => censusedClasses.has(member))

const recordWithIndexKeyNamesAField = (representation: Representation, keyText: string | null): boolean => {
  if (representation.kind !== 'record-with-index' || keyText === null) return false
  return representation.fields.some((field) => field.key === keyText)
}

/** The declared fields of a generated record layout, or `null` for a carrier that has none. */
const generatedFieldsOf = (representation: Representation, deriver: RepresentationDeriver): readonly RecordField[] | null => {
  if (representation.kind === 'record' || representation.kind === 'record-with-index') return representation.fields
  if (representation.kind === 'class-ref' || (representation.kind === 'native-record-ref' && representation.native === null)) {
    const layout = deriver.layoutOf(representation.shapeId as StructuralTypeId)
    return layout.kind === 'record' || layout.kind === 'record-with-index' ? layout.fields : null
  }
  return null
}

const deleteNamesOptionalGeneratedField = (
  representation: Representation,
  keyText: string | null,
  deriver: RepresentationDeriver
): boolean => {
  if (keyText === null) return false
  return generatedFieldsOf(representation, deriver)?.some((field) => field.key === keyText && !field.required) === true
}

/**
 * A constant delete key naming NO declared field of a plain record: the key
 * lives in the record's expando sidecar (one `Object.defineProperty` added
 * after the fact), the one table `emitNativeSidecarDelete` can actually erase
 * from. Refined by name so that the plain `record:delete:false` -- a constant
 * key naming a REQUIRED field -- stays unclaimed: a required field has no
 * presence its typed reads consult, so its deletion cannot be honoured, and
 * the manifest must not say otherwise.
 */
const deleteNamesRecordExpandoKey = (representation: Representation, keyText: string | null, deriver: RepresentationDeriver): boolean => {
  if (keyText === null || representation.kind !== 'record') return false
  const fields = generatedFieldsOf(representation, deriver)
  return fields !== null && !fields.some((field) => field.key === keyText)
}

const deleteNamesNativeIndexEntry = (representation: Representation, keyText: string | null, deriver: RepresentationDeriver): boolean => {
  if (!nativeRecordRefHasIndexSidecar(representation, deriver) || keyText === null) return false
  const layout = deriver.layoutOf((representation as Extract<Representation, { kind: 'native-record-ref' }>).shapeId as StructuralTypeId)
  if (layout.kind !== 'record-with-index') return false
  return !layout.fields.some((field) => field.key === keyText)
}

const callableMemberIs = (keyText: string | null, member: string): boolean => keyText === member

const iteratorMemberNameOf = (keyText: string | null): string => keyText ?? 'non-constant-key'

const callableComputedOwnSymbolRead = (access: Access, keyRepresentation: Representation | null): boolean =>
  access.method === 'get' && access.computed && keyRepresentation?.kind === 'symbol'

const callableComputedOwnSymbolWrite = (access: Access, keyRepresentation: Representation | null): boolean =>
  access.method === 'set' && access.computed && keyRepresentation?.kind === 'symbol'

const callableOwnPropertyRead = (receiver: string, access: Access, keyText: string | null): boolean => {
  if (access.method !== 'get' || access.computed || keyText === null) return false
  if (keyText === 'name' || keyText === 'length') return true
  if (receiver === 'function-and-constructor' && keyText === 'prototype') return true
  return !nonExpandoFunctionMemberNames.has(keyText) && keyText !== 'prototype'
}

// ---------------------------------------------------------------------------
// The callable `.call`/`.apply`/`.bind` builtin ladder needs a whole-program
// own-property-mutation census (`semantics/callable-origins.ts`), which is
// keyed by a `SealedRepresentationPlan` -- a fact `CertifyContext` does not
// carry (its own doc comment names this as one of two facts still read off
// the graph pending Phase 3). `canCarryCallableObject`, the plan's only use
// inside that census, asks nothing the plan narrows: it distinguishes a
// callable-shaped result from everything else by KIND, which a value's own
// declared type already settles before any per-site narrowing runs. So a
// plan built once here, from each published result's own raw derivation
// (`deriver.derive`, never the census's per-use narrowing), answers the
// identical question the real plan would -- and lets `callableBuiltinRecipeKey`
// run completely unmodified.
// ---------------------------------------------------------------------------

const syntheticPlans = new WeakMap<SemanticGraph, SealedRepresentationPlan>()

const syntheticPlanFor = (graph: SemanticGraph, deriver: RepresentationDeriver): SealedRepresentationPlan => {
  const cached = syntheticPlans.get(graph)
  if (cached) return cached
  const selected = new Map<SemanticResultId, Representation>()
  for (const producer of graph.operations.values()) {
    for (const result of producer.results) {
      if (!selected.has(result.id)) selected.set(result.id, deriver.derive(result.type))
    }
  }
  const plan: SealedRepresentationPlan = {
    selected,
    evidence: new Map<SemanticResultId, readonly RepresentationEvidence[]>(),
    conflicts: []
  }
  syntheticPlans.set(graph, plan)
  return plan
}

const censusedClassesByGraph = new WeakMap<SemanticGraph, ReadonlySet<DeclarationId>>()

const censusedClassesFor = (graph: SemanticGraph): ReadonlySet<DeclarationId> => {
  const cached = censusedClassesByGraph.get(graph)
  if (cached) return cached
  const censused = classDeclarationsWithLifecycleEvents(graph)
  censusedClassesByGraph.set(graph, censused)
  return censused
}

// ---------------------------------------------------------------------------
// `get`/`set`/`delete`/`own-property-keys`/`define-own-property`
// ---------------------------------------------------------------------------

/**
 * The receiver key the manifest's `propertyRecipes` set claims, exactly
 * mirroring `preflight/property-access.ts`'s `buildPropertyAccessObligation`
 * ternary ladder in the same precedence order -- first match wins, so the
 * order below is load-bearing and copied line for line.
 */
const receiverKeyOf = (
  ctx: CertifyContext,
  access: Access,
  representation: Representation,
  key: IrOperand | null,
  keyText: string | null,
  semanticOp: SemanticOperation | null
): string => {
  const recordIndexes = recordIndexesOf(representation, ctx.deriver)
  const indexCarrier = key ? key.representation : null
  const indexDomainMatches = indexCarrier !== null && recordIndexForKeyCarrier(recordIndexes, indexCarrier, keyText ?? undefined) !== null
  if (
    access.computed &&
    recordIndexes.length > 0 &&
    (access.method === 'get' || access.method === 'set' || access.method === 'define-own-property') &&
    !indexDomainMatches
  ) {
    return `${access.receiver}(no-index-domain)`
  }
  if (
    access.method === 'delete' &&
    key &&
    disjointNativeRecordIndexOf(ctx.deriver, representation, key.representation, keyText ?? undefined)
  )
    return 'record(disjoint-index)'
  if (access.method === 'delete' && deleteNamesOptionalGeneratedField(representation, keyText, ctx.deriver)) return 'record(optional-field)'
  if (access.method === 'delete' && deleteNamesRecordExpandoKey(representation, keyText, ctx.deriver)) return 'record(expando-key)'
  if (access.method === 'delete' && deleteNamesNativeIndexEntry(representation, keyText, ctx.deriver))
    return 'native-record-ref(index-sidecar)'
  const nativeNumericUnion =
    indexCarrier?.kind === 'scalar' && indexCarrier.domain === 'number' && hasNativeNumericIndexArms(representation, ctx.deriver.derive)
  if (access.receiver === 'tagged-union' && access.computed && nativeNumericUnion && (access.method === 'get' || access.method === 'set')) {
    return 'tagged-union(numeric-index-arms)'
  }
  if (access.receiver === 'constructor-family' && !constructorFamilyIsCensused(representation, censusedClassesFor(ctx.graph))) {
    return 'constructor-family(uncensused)'
  }
  if (
    access.receiver === 'native-record-ref' &&
    access.method === 'get' &&
    access.computed &&
    !nativeRecordRefHasIndexSidecar(representation, ctx.deriver)
  ) {
    return 'native-record-ref(no-index-sidecar)'
  }
  if (
    access.receiver === 'record-with-index' &&
    access.method === 'get' &&
    !access.computed &&
    !recordWithIndexKeyNamesAField(representation, keyText)
  ) {
    return 'record-with-index(unmatched-key)'
  }
  if (access.receiver === 'tagged-union' && access.computed && taggedUnionArmsAreAllTypedArrays(representation))
    return 'tagged-union(typed-array-arms)'
  if (
    access.receiver === 'tagged-union' &&
    access.method === 'get' &&
    access.computed &&
    taggedUnionArmsAreAllDictionaries(representation)
  ) {
    return 'tagged-union(dictionary-arms)'
  }
  if (
    access.receiver === 'tagged-union' &&
    access.method === 'get' &&
    access.computed &&
    taggedUnionArmsAreAllArrayObjects(representation)
  ) {
    return 'tagged-union(array-arms)'
  }
  if (
    access.receiver === 'tagged-union' &&
    (access.method === 'get' || access.method === 'set') &&
    access.computed &&
    taggedUnionArmsHaveNativeSidecar(representation)
  ) {
    return 'tagged-union(native-sidecar-arms)'
  }
  if (access.receiver === 'iterator' && access.method === 'get' && !access.computed) return `iterator(${iteratorMemberNameOf(keyText)})`
  const callableBuiltinRecipe = semanticOp
    ? callableBuiltinRecipeKey(ctx.graph, syntheticPlanFor(ctx.graph, ctx.deriver), semanticOp, access)
    : null
  if (callableBuiltinRecipe !== null) return callableBuiltinRecipe
  const directFunctionSourceRead = semanticOp !== null && isDirectFunctionSourceRead(ctx.graph, semanticOp)
  if (access.receiver === 'function-value-dispatch' && directFunctionSourceRead) return 'function-value-dispatch(toString-direct)'
  // The same two facts off a callable that has NO calling convention. A
  // `callable-identity` is the whole answer for `Array.from`, whose four
  // overloads disagree at parameter 0 (`representation/derive.ts`): the
  // program reads its `name` and `length` and never calls it, and the facts
  // live in the identity's own property table exactly as a dispatching
  // callable's do. Refined per-site by the same `callableMemberIs`, so every
  // other member off this carrier stays correctly unclaimed -- there is no
  // `.call`, `.bind` or expando arm for it, and a call is refused by name.
  if (access.receiver === 'callable-identity' && access.method === 'get' && !access.computed && callableMemberIs(keyText, 'name')) {
    return 'callable-identity(name)'
  }
  if (access.receiver === 'callable-identity' && access.method === 'get' && !access.computed && callableMemberIs(keyText, 'length')) {
    return 'callable-identity(length)'
  }
  if (access.receiver === 'function-value-dispatch' && access.method === 'get' && !access.computed && callableMemberIs(keyText, 'name')) {
    return 'function-value-dispatch(name)'
  }
  if (access.receiver === 'function-value-dispatch' && access.method === 'get' && !access.computed && callableMemberIs(keyText, 'length')) {
    return 'function-value-dispatch(length)'
  }
  // A `prototype` read through a call-only carrier. One recipe for both of the
  // census's answers, because both are the SAME read: a function that ran
  // `MakeConstructor` finds an own `prototype`, and an arrow, a method or an
  // `async function` misses and walks `Function.prototype`, which has none --
  // `undefined`, which is what Node prints. What is refused is the third
  // answer: a generator states nothing and a value with no proven origin
  // proves nothing, and both fall through to the bare receiver key, which the
  // manifest registers nowhere.
  if (
    access.receiver === 'function-value-dispatch' &&
    access.method === 'get' &&
    !access.computed &&
    callableMemberIs(keyText, 'prototype') &&
    semanticOp !== null &&
    callableOwnPrototypeAt(ctx.graph, semanticOp) !== null
  ) {
    return 'function-value-dispatch(prototype)'
  }
  const keyRepresentation = key ? key.representation : null
  if (access.receiver === 'function-value-dispatch' && callableComputedOwnSymbolWrite(access, keyRepresentation))
    return 'function-value-dispatch(own-symbol)'
  if (access.receiver === 'function-value-dispatch' && functionValueOwnPropertyWrite(access)) return 'function-value-dispatch'
  if (access.receiver === 'function-and-constructor' && callableComputedOwnSymbolWrite(access, keyRepresentation))
    return 'function-and-constructor(own-symbol)'
  if (access.receiver === 'function-and-constructor' && functionValueOwnPropertyWrite(access)) return 'function-and-constructor'
  if (access.receiver === 'function-value-dispatch' && callableOwnPropertyRead(access.receiver, access, keyText))
    return 'function-value-dispatch(expando)'
  if (access.receiver === 'function-value-dispatch' && callableComputedOwnSymbolRead(access, keyRepresentation))
    return 'function-value-dispatch(own-symbol)'
  if (access.receiver === 'function-and-constructor' && directFunctionSourceRead) return 'function-and-constructor(toString-direct)'
  if (access.receiver === 'function-and-constructor' && access.method === 'get' && !access.computed && callableMemberIs(keyText, 'name')) {
    return 'function-and-constructor(name)'
  }
  if (
    access.receiver === 'function-and-constructor' &&
    access.method === 'get' &&
    !access.computed &&
    callableMemberIs(keyText, 'length')
  ) {
    return 'function-and-constructor(length)'
  }
  if (
    access.receiver === 'function-and-constructor' &&
    access.method === 'get' &&
    !access.computed &&
    callableMemberIs(keyText, 'prototype')
  ) {
    return 'function-and-constructor(prototype)'
  }
  if (access.receiver === 'function-and-constructor' && callableOwnPropertyRead(access.receiver, access, keyText))
    return 'function-and-constructor(expando)'
  if (access.receiver === 'function-and-constructor' && callableComputedOwnSymbolRead(access, keyRepresentation))
    return 'function-and-constructor(own-symbol)'
  return access.receiver
}

const accessDemandOf = (operation: AccessOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  // A receiver inside a proven-dead `typeof` guard's consequent, or one whose
  // semantic type is `never`, is never actually accessed on this host --
  // `preflight/property-access.ts`'s own two skip conditions, restated
  // against the IR's `lineage` citation instead of the semantic operation id.
  if (ctx.isDead(operation.lineage)) return []
  const semanticOp = ctx.semanticOperationOf(operation.lineage)
  if (semanticOp && receiverIsUnreachable(ctx.graph, semanticOp, ctx.deriver)) return []
  const { receiver, key } = receiverAndKeyOf(operation)
  const representation = receiver.representation
  const computed = key !== null && isComputedKey(ctx, key)
  const keyText = key !== null ? constantKeyTextOf(ctx, key) : null
  const access: Access = { receiver: representation.kind, method: operation.kind, computed }
  const receiverKey = receiverKeyOf(ctx, access, representation, key, keyText, semanticOp)
  return [
    { key: `property-access:${receiverKey}:${access.method}:${access.computed}` },
    ...(operation.kind === 'get' && !computed && keyText !== null ? hostMemberReadDemandOf(representation, keyText) : [])
  ]
}

/**
 * A constant-keyed read off a `native-handle` receiver names one host member,
 * and the printer (`host/emit-host-properties.ts`'s `nativeHostMemberText`)
 * renders it only when a host member table claims `${protocol}.${member}` --
 * every other such read is refused there by name. The manifest publishes
 * exactly those keys (`hostMembers`), so the demand is the same lookup made
 * before a certificate is minted rather than after.
 *
 * Two reads the printer answers without a table row are left undemanded, on
 * purpose: `hasOwnProperty`/`propertyIsEnumerable` off a classified intrinsic
 * (`Math.hasOwnProperty(...)`) are `Object.prototype`'s own and answered from
 * the intrinsic's reflection sidecar, and a `<X>.prototype` protocol's method
 * read as a value is spelled from the checker's own member list. Both are
 * decided by facts (`intrinsicMembers`) this walk does not carry, and a
 * demand that cannot be decided here would refuse programs the printer
 * renders -- the opposite drift from the one this demand closes.
 */
const hostMemberReadDemandOf = (receiver: Representation, member: string): readonly CapabilityDemand[] => {
  if (receiver.kind !== 'native-handle') return []
  const protocol = receiver.native ?? receiver.protocol
  if (protocol.endsWith('.prototype') || objectShapePrototypeMethods.has(member)) return []
  return [{ key: `host-invocation:${protocol}.${member}` }]
}

// ---------------------------------------------------------------------------
// `has-property` (`k in o`) -- `preflight/has-property-key.ts`'s
// `hasPropertyHelperKey`, restated against the IR's own key/receiver
// representations. Unlike the five methods above, `has-property` never
// raises a `property-access` demand: `family: 'property', internalMethod:
// 'has-property'` is declared in the semantic model but no producer ever
// builds one (only the `in` computation reaches this IR op), so the old
// `buildPropertyAccessObligation` -- gated on `operation.family ===
// 'property'` -- never actually saw one either.
// ---------------------------------------------------------------------------

/** A property key's constant is always `literal: 'string'`; the `in` operator's left operand is an ordinary expression, so it keeps whichever literal kind it was written with. */
const staticInKeyOf = (ctx: CertifyContext, key: IrOperand): { readonly text: string; readonly form: string } | null => {
  const definition = ctx.definitionOf(key.value)
  if (definition?.kind !== 'constant') return null
  if (definition.literal === 'string') return { text: definition.text, form: 'static-string' }
  return definition.literal === 'number' ? { text: definition.text, form: 'static-number' } : null
}

const dynamicInKeyFormOf = (key: IrOperand): string => {
  const representation = key.representation
  if (representation.kind !== 'scalar') return representation.kind
  return representation.domain === 'boolean' || representation.domain === 'bigint' ? `scalar(${representation.domain})` : 'number'
}

const hasPropertyRuntimeHelperKey = (operation: HasPropertyOperation, ctx: CertifyContext): string => {
  const key = staticInKeyOf(ctx, operation.key)
  const keyForm = key?.form ?? dynamicInKeyFormOf(operation.key)
  const carrier = operation.receiver.representation
  const payload = carrier.kind === 'optional' ? carrier.payload : carrier
  const optionalPrefix = (suffix: string): string => (carrier.kind === 'optional' ? `optional(${suffix})` : suffix)
  // Pattern is a `native-record-ref` whose own name is not `null`
  // (`generatedSharedObjectCarrier`/`generatedSharedRecordCarrier` both
  // exclude that on purpose: an arbitrary host struct's C++ members are not
  // thereby its own JS keys), so neither of the two carrier checks below ever
  // answers for it -- every key, static or dynamic, fell through to the
  // generic layout suffix, which named the unclaimed `record(unproven)` this
  // file's own manifest (`emit-in.ts`'s `hasPropertyHelperClaims`) has no row
  // for. `emit-in.ts`'s `layoutAnswerFor` already renders `in` over Pattern
  // unconditionally through its native dynamic-property sidecar
  // (`gea::runtime::regex::dynamicHas`, checked ahead of every other rule
  // there for exactly this reason) -- this claim states the identical answer
  // for the identical receiver, checked at the identical priority, so the
  // two authorities cannot drift back apart.
  if (regexpRoleOf(payload) === 'pattern') return `computation:in:${keyForm}:${optionalPrefix('record(pattern)')}`
  if (key === null && nativeRecordIndexHasPropertyOf(ctx.deriver, payload, operation.key.representation))
    return `computation:in:${keyForm}:${optionalPrefix('record(disjoint-index)')}`
  if (key && payload.kind === 'class-ref' && classPrototypeMemberIsPresent(ctx.classes, payload.declaration, key.text)) {
    return `computation:in:${keyForm}:${optionalPrefix('class(prototype-member)')}`
  }
  if (key && generatedObjectCarrier(payload) && objectPrototypeMemberNames.has(key.text)) {
    return `computation:in:${keyForm}:${optionalPrefix('record(object-prototype-member)')}`
  }
  if (key && generatedSharedObjectCarrier(payload)) {
    const layout = resolvedLayoutOf(payload, ctx.deriver).layout
    if (recordAnswerFor(layout, key.text) === 'record(unproven)') return `computation:in:${keyForm}:${optionalPrefix('record(sidecar)')}`
  }
  if (key === null && keyForm === 'string' && generatedSharedRecordCarrier(payload)) {
    return `computation:in:${keyForm}:${optionalPrefix('record(sidecar)')}`
  }
  // A SYMBOL key, which is never a name the program spelled -- `staticInKeyOf`
  // recognizes string and number literals only, because a symbol has no
  // literal form at all; `cacheKey in res` reads a `unique symbol` binding.
  // The receiver's own dynamic-property sidecar answers a runtime key of any
  // kind, and for a symbol it answers COMPLETELY whenever the layout declares
  // no symbol-keyed slot of its own -- see `symbolKeyedMemberIsDeclared` for
  // why the two key spaces make that a proof rather than a guess. Without this
  // row `@hono/node-server`'s three symbol `in` tests fell through to
  // `record(unproven)`, whose whole meaning is "absence is not provable", even
  // though presence AND absence are both provable here.
  if (key === null && keyForm === 'symbol' && generatedSharedObjectCarrier(payload)) {
    const layout = resolvedLayoutOf(payload, ctx.deriver).layout
    const fields = layout.kind === 'record' || layout.kind === 'record-with-index' ? layout.fields : null
    const declaration = payload.kind === 'class-ref' ? payload.declaration : null
    if (!symbolKeyedMemberIsDeclared(ctx.classes, fields, declaration)) {
      return `computation:in:${keyForm}:${optionalPrefix('record(symbol-sidecar)')}`
    }
  }
  const layout = resolvedLayoutOf(carrier, ctx.deriver).layout
  return `computation:in:${keyForm}:${layoutAnswerSuffix(layout, key?.text ?? null, ctx.deriver)}`
}

// ---------------------------------------------------------------------------
// `instanceof` -- `preflight/instanceof-key.ts`'s `instanceofHelperKey`,
// restated against the two compute operands' own representations.
// ---------------------------------------------------------------------------

const instanceofSideKey = (
  ctx: CertifyContext,
  role: 'left' | 'right',
  operand: IrOperand | undefined,
  mapTestableAgainst: IrOperand | undefined
): string => {
  if (!operand) return 'absent'
  if (ctx.definitionOf(operand.value)?.kind === 'constant') return 'constant'
  const representation = operand.representation
  if (representation.kind === 'tagged-union' && representation.arms.every((arm) => definitelyPrimitive(arm.value))) {
    return 'tagged-union(primitive-only)'
  }
  // Only the LEFT side is refined against the RIGHT: `instanceofHelperKey`'s
  // `mapTestable` special case is keyed on `role === 'left'`, so the right
  // operand's own call passes no counterpart to test against.
  const right = mapTestableAgainst?.representation
  if (
    representation.kind === 'tagged-union' &&
    right?.kind === 'native-handle' &&
    right.protocol === 'MapConstructor' &&
    mapTestable(representation)
  ) {
    return 'tagged-union(map-testable)'
  }
  if (representation.kind === 'native-handle') return `native-handle(${representation.protocol})`
  // A RIGHT-hand `native-record-ref` names WHICH host layout, for the same
  // reason the native-handle row above names which protocol: a host's own
  // `[[HasInstance]]` is declared per layout
  // (`PluginCapabilities.hostInstanceTests`), so one flat `native-record-ref`
  // claim would certify `instanceof` against every host struct in the program
  // on the strength of a row written for one of them. Right side only: the LEFT
  // spelling is already claimed bare (`computation:instanceof:native-record-ref:
  // native-handle(ErrorConstructor)`), and there it says how the OPERAND is
  // carried rather than which `[[HasInstance]]` is being asked for.
  if (role === 'right' && representation.kind === 'native-record-ref' && representation.native !== null) {
    return `native-record-ref(${representation.native})`
  }
  return representation.kind
}

const instanceofRuntimeHelperKey = (operands: readonly IrOperand[], ctx: CertifyContext): string => {
  const left = operands[0]
  const right = operands[1]
  return `computation:instanceof:${instanceofSideKey(ctx, 'left', left, right)}:${instanceofSideKey(ctx, 'right', right, undefined)}`
}

// ---------------------------------------------------------------------------
// Atomics -- `preflight/invocation-arguments.ts`'s `buildAtomicsInvocationObligation`.
// `host-member-call` states its own verdict (`ir/certify.ts`'s own doc: an
// `Atomics` member's admissible argument shapes are a target RULE, not a
// finite manifest set), so this is the one property-access-module demand
// that never goes through `verdictOf`'s manifest lookup.
// ---------------------------------------------------------------------------

/**
 * The `${protocol}.${member}` a call's callee reads, when that callee is a
 * `get` off a host-bound receiver. Preferring the `get` operation's own
 * `hostMethod` binding (set only when a plugin's `HostMethodBindingTable`
 * explicitly claimed the member) and falling back to reconstructing it from
 * the `get`'s own already-narrowed receiver and its key's defining constant
 * -- the same two facts `preflight/invocation-arguments.ts`'s
 * `hostMemberOfCallee` read off the plan, available here directly off the
 * IR with no plan lookup at all, since `Atomics.*` is a namespace member
 * read this compiler has never routed through a `HostMethodBinding`.
 */
const hostMemberOfCall = (ctx: CertifyContext, operation: CallOperation): string | null => {
  const calleeDefinition = ctx.definitionOf(operation.callee.value)
  if (calleeDefinition?.kind !== 'get') return null
  if (calleeDefinition.hostMethod) return `${calleeDefinition.hostMethod.protocol}.${calleeDefinition.hostMethod.member}`
  const receiver = calleeDefinition.receiver.representation
  const host =
    receiver.kind === 'native-handle'
      ? (receiver.native ?? receiver.protocol)
      : receiver.kind === 'native-record-ref'
        ? receiver.native
        : null
  if (host === null) return null
  const keyText = constantKeyTextOf(ctx, calleeDefinition.key)
  return keyText === null ? null : `${host}.${keyText}`
}

const atomicsDemandOf = (operation: CallOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  const member = hostMemberOfCall(ctx, operation)
  if (!member?.startsWith('Atomics.')) return []
  const name = member.slice('Atomics.'.length)
  const support = atomicsCallSupport(
    name,
    operation.arguments.map((argument) => argument.representation)
  )
  return [
    support.supported
      ? { key: `host-member-call:${member}`, verdict: 'installed' }
      : { key: `host-member-call:${member}`, verdict: 'unsupported', detail: support.reason }
  ]
}

/**
 * The one intercepted host argument whose declared type is broader than its
 * renderer: `Object.defineProperty`'s descriptor. The declaration says
 * `PropertyDescriptor & ThisType<any>`, so a `dynamic` operand reaches the
 * call's slot unconverted -- there is no conversion to demand -- but the
 * printer materializes a descriptor only from a carrier that states which
 * fields and attributes are present (an object literal record, or the record
 * `getOwnPropertyDescriptor` hands back), and refuses a box by name. The old
 * `preflight/invocation-arguments.ts` stated this rule for the plan; it is
 * restated here for the IR so the refusal is a certification verdict rather
 * than a print-time surprise on a certified program.
 *
 * `dynamicArgumentHostParameters` is the waiver: a member/position listed
 * there takes the box through unconditionally (`defineProperty`'s KEY is
 * listed, its descriptor deliberately is not -- `host/dynamic-argument-
 * members.ts` states why per row), so a waived position is never refused.
 */
const hostArgumentDemandOf = (operation: CallOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  const member = hostMemberOfCall(ctx, operation)
  if (member !== 'ObjectConstructor.defineProperty') return []
  const waivers = ctx.manifest.dynamicArgumentHostParameters
  return operation.arguments.flatMap((argument, ordinal) => {
    if (argument.representation.kind !== 'dynamic' || ordinal !== 2) return []
    if (waivers?.has(`${member}:argument:${ordinal}`) || waivers?.has(`${member}:argument:*`)) return []
    return [
      {
        key: `host-member-call:${member}`,
        verdict: 'unsupported',
        detail:
          `"${member}" was passed a "${representationKey(argument.representation)}" descriptor; a descriptor is either one this ` +
          'program received from Object.getOwnPropertyDescriptor or an object literal whose fields the checker knows, and a box ' +
          'states neither which attributes it means to set nor with what'
      } satisfies CapabilityDemand
    ]
  })
}

// ---------------------------------------------------------------------------

export const propertyAccessKeysOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  switch (operation.kind) {
    case 'get':
    case 'set':
    case 'delete':
    case 'define-own-property':
    case 'own-property-keys':
      return accessDemandOf(operation, ctx)
    case 'has-property':
      return [{ key: `runtime-helper:${hasPropertyRuntimeHelperKey(operation, ctx)}` }]
    case 'compute':
      return operation.form === 'instanceof' ? [{ key: `runtime-helper:${instanceofRuntimeHelperKey(operation.operands, ctx)}` }] : []
    case 'call':
      return [...atomicsDemandOf(operation, ctx), ...hostArgumentDemandOf(operation, ctx)]
    default:
      return []
  }
}
