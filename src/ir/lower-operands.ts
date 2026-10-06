import {
  operationOfResult,
  type DeclarationId,
  type FunctionId,
  type IrValueId,
  type OperationId,
  type ResultRole,
  type SemanticResultId,
  type StructuralTypeId
} from '../identity/ids.js'
import { exactArmIndexOf, type ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNode } from '../conversion/algebra.js'
import { detachedMethodAbiOf, isClosedContiguousTupleRecord } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import type { SlotCensus } from '../projection/slots.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { recordFieldKeyOf } from '../representation/object-shape.js'
import type { FamilyMemberKeys } from '../conversion/record-view.js'
import {
  isOpenDocument,
  representationKey,
  type CallableAbi,
  type RecordField,
  type Representation,
  type TaggedUnionArm
} from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import { conversionRoleTargetOf, type SemanticOperation } from '../semantics/model/operations.js'
import type { IrBodyBuilder } from './build.js'
import { anchorResultOf, IrLoweringBlockedError, requireRepresentation } from './lower-graph.js'
import type { PendingShortCircuit } from './lower-short-circuit.js'
import type { IrBlockId, IrOperand } from './model.js'

/**
 * Reading an operation's inputs and publishing its result.
 *
 * Every lowering step needs the same three answers -- where does this operand's
 * value come from, which carrier does it arrive in, and under which identity is
 * the result visible to the next step -- and they have to be the same answers
 * everywhere. Two lowerings that each resolved a `parameter` operand their own
 * way would disagree about the frame, which is not a defect any later layer can
 * see: both would produce a well-formed body, and only one would be reading
 * what the caller actually pushed.
 */

/**
 * The whole-program answers a body cannot derive from its own operations.
 *
 * A class's members and each function's convention are projected once, before
 * any body lowers, precisely so two bodies cannot disagree about them. A
 * lowering that needed one and re-derived it locally would be that second
 * opinion, so the projections are handed in rather than recomputed.
 */
export interface LoweringProgram {
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
  /** Checker-authenticated callable identity carried by semantic values. */
  readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
  readonly callableOwnPropertyWrites: ReadonlyMap<FunctionId, ReadonlySet<string>>
  readonly functionPrototypePropertyWrites: ReadonlySet<string>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Which carrier each operand must arrive in (`projection/slots.ts`). */
  readonly slots: SlotCensus
  /** One conversion node per carrier pair (`conversion/nodes.ts`); every `convert` this lowering mints names one. */
  readonly conversions: ConversionCensus
  /**
   * Every slot `enter` could not fill: the operand's carrier differs from its
   * slot and the census has no conversion for the pair. The operand went
   * through unconverted, exactly as it did before slots existed, so the
   * printer's own per-consumer path still renders (or refuses) it. Counted
   * rather than refused while that path is still the printer's, so the
   * refactor can see the pairs the census must learn before the printer's
   * path is deleted; it becomes a refusal then.
   */
  readonly drift: SlotDrift[]
  /**
   * Every property read that produced a method VALUE -- a callable carrier
   * stating a receiver -- keyed by the value it produced, with the object it
   * was read from and the body it names. `enter` binds the two when such a
   * value reaches a receiver-less slot (see `BindCallableOperation.detached`).
   */
  readonly methodValueReceivers: Map<IrValueId, { readonly receiver: IrOperand; readonly method: FunctionId }>
  /**
   * The installed plugins' reactive-field statement, merged once for this
   * lowering run exactly as `compiler.ts` merges it into
   * `HostSpellings.reactive.fields` -- but gated on a cell actually being
   * configured (empty when no plugin names one), so a `true` reading of
   * `GetOperation.reactive`/`BindingReadOperation.reactive` always means a
   * real cell exists, never merely that some plugin named the field without
   * anything to render it into. See `GetOperation.reactive`.
   */
  readonly reactiveFields: ReadonlyMap<DeclarationId, ReadonlySet<string>>
  /**
   * The FIELD declarations (not the class declarations `reactiveFields` is
   * keyed by) that are reactive -- the reverse index a resolved-binding
   * property read needs, since `PropertyOperation.resolvedBinding` names the
   * field's own declaration directly, with no receiver/key pair left to walk
   * through `classMemberOf`. Built once from `classes` and `reactiveFields`
   * (`ir/lower.ts`) rather than per read, because a body cannot see the
   * classes it does not declare.
   */
  readonly reactiveFieldDeclarations: ReadonlySet<DeclarationId>
  /**
   * For each `for (let ...)` loop, the head bindings a closure reaches and so
   * must be renewed per iteration (`BindingRenewOperation`), each with the
   * lineage of its own introduction. A head binding no other frame names is
   * left out: renewing a cell only this frame holds is unobservable.
   */
  readonly perIterationRenewals: ReadonlyMap<OperationId, readonly PerIterationRenewal[]>
}

export interface PerIterationRenewal {
  readonly declaration: DeclarationId
  readonly lineage: SemanticResultId
}

/**
 * Whether a property read's receiver+key names a field an installed plugin
 * declared a reactive cell.
 *
 * Answered once, here, at the point a `get` is about to be built
 * (`lower-property.ts`, `lower-destructuring.ts`'s object-pattern step) --
 * see `GetOperation.reactive` for why this belongs on the operation instead
 * of being re-asked from a table the target does not publish until struct
 * rendering. `classMemberOf` finds the field's DECLARING class along the
 * inheritance chain, which is the class `reactiveFields` is keyed by (own
 * fields only -- `component-classes.ts`'s `GeaReactiveFields`); a receiver
 * that is not a class at all (a record, a dictionary, ...) answers `false`
 * without a lookup, since the plugin's table only ever names class fields.
 */
export const reactiveFieldReadOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: Representation,
  key: string,
  reactiveFields: ReadonlyMap<DeclarationId, ReadonlySet<string>>
): boolean => {
  if (receiver.kind !== 'class-ref') return false
  const site = classMemberOf(classes, receiver.declaration, key)
  return site !== null && site.kind === 'field' && reactiveFields.get(site.owner)?.has(key) === true
}

export interface SlotDrift {
  /** The block that would execute this conversion, retained for control-flow pruning. */
  readonly block: IrBlockId
  readonly operation: OperationId
  readonly role: string
  readonly ordinal: number
  readonly source: string
  readonly slot: string
  readonly reason: string
  /** The pair itself, so an instrument can ask the registry about it without re-deriving. */
  readonly sourceRepresentation: Representation
  readonly slotRepresentation: Representation
}

export interface LoweringContext {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  readonly constantDeriver: RepresentationDeriver
  readonly program: LoweringProgram
  /** This owner's calling convention, or `null` for a region nobody calls. */
  readonly abi: CallableAbi | null
  /**
   * Why this body has no convention, when the ABI projection refused to give it
   * one, and `null` otherwise.
   *
   * The projection already knows the answer -- it states three distinct failure
   * modes by name (`projection/abi.ts`) -- and a body whose convention is absent
   * then refuses with the *symptom*, "reads ABI position 0", which names neither
   * the cause nor a thing to fix. Carrying the reason turns that report back
   * into the one the projection already made. `null` covers two different
   * situations that are both correctly silent here: a region nobody calls, which
   * genuinely has no convention to refuse, and a function the projection never
   * considered -- and inventing a reason for either would be this layer guessing
   * at another's answer.
   */
  readonly abiRefusal: string | null
  readonly builder: IrBodyBuilder
  /** Every result this owner has lowered so far, keyed by the anchor result each defining operation registered. */
  readonly values: Map<SemanticResultId, IrValueId>
  /** Optional-chain expressions whose merge is recorded but not yet closed (`lower-short-circuit.ts`). */
  readonly shortCircuits: Map<SemanticResultId, PendingShortCircuit>
  /**
   * Whether this owner's declaration states `@gea-exact-arms`
   * (`AllocationOperation.exactArms`): a tagged-union operand entering a slot
   * that is exactly one of its arms takes the census's exact-arm projection
   * instead of `nodeFor`'s per-arm dispatch. Per owner rather than per site
   * because the tag is a statement about the body's own guards, which the
   * lowering has no way to evaluate site by site.
   */
  readonly exactArmNarrowing: boolean
}

export const describeOperand = (operand: SemanticOperand): string => `operand "${operand.role}"#${operand.ordinal}`

/** The ABI projection's stated reason, ready to append to a refusal, or nothing when it stated none. */
const abiRefusalOf = (ctx: LoweringContext): string =>
  ctx.abiRefusal === null ? '' : `; the ABI projection refused this convention because ${ctx.abiRefusal}`

/** A published result's carrier plus the SSA id already minted for it -- the only legal source for an operand that names a prior result. */
export const resolveResultValue = (ctx: LoweringContext, result: SemanticResultId, describe: string): IrOperand => {
  const value = ctx.values.get(result)
  if (!value) {
    throw new IrLoweringBlockedError(
      `${describe} references result ${result}, which was not lowered in this owner ` +
        '(a value produced by a different owner needs capture lowering, which is not supported yet)'
    )
  }
  return { value, representation: requireRepresentation(ctx.plan, result, describe) }
}

export const resolveRequiredOperand = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand
): IrOperand => {
  const source = operand.source
  if (source.kind === 'absent') throw new IrLoweringBlockedError(`${describeOperand(operand)} is absent where a value is required`)
  // A result whose carrier is `void` minted no SSA name (`namesVoidResult`),
  // and an operand that reads one -- `let u: number | void = f()`, `return
  // f()` in a valued function, `g(f())` -- is a STORED position, where the
  // language's value for "nothing" is `undefined`
  // (`representation/primitives.ts`'s `storedCarrier`, the same rule the
  // representations apply to every nested `void`). A consumer that can
  // genuinely take nothing (`return f()` in a `void` function, an expression
  // statement) asks `namesVoidResult` itself before resolving. A `never`-typed
  // result shares the void carrier and is the opposite fact -- the point past
  // `return Debug.fail(...)` is unreachable, not undefined. `return` asks
  // first and renders nothing (`emit-return.ts`). Every other consumer --
  // `const b: Bindings = load()` past node-compat's rewritten
  // `require('<x>.node')`, `await readFile(...)` on an unimplemented
  // `fs/promises` member -- reads a value no execution observes, because the
  // call already threw. It gets the one value a dead point can honestly hold,
  // the one `lower-narrow.ts` hands a `never` merge arm: an `undefined` whose
  // conversion into any real carrier `emit.ts` renders as
  // `gea::host::unreachableValue<T>()`. The call itself was lowered in this
  // owner; only its value was (correctly) never minted, so refusing here named
  // a capture that does not exist.
  if (source.kind === 'result' && namesVoidResult(ctx, operand)) {
    const absent: Representation = { kind: 'undefined' }
    return { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', absent), representation: absent }
  }
  if (source.kind === 'result') return resolveResultValue(ctx, source.result, describeOperand(operand))
  if (source.kind === 'parameter') {
    // The carrier comes from the ABI slot, not from the operand's own type: the
    // ABI is what the caller pushed, and a body that read the slot as anything
    // else would be reading a frame nobody wrote.
    const declared = ctx.abi?.parameters[source.ordinal]
    if (!declared) {
      throw new IrLoweringBlockedError(
        `${describeOperand(operand)} reads ABI position ${source.ordinal}, which this body's calling convention does not declare` +
          abiRefusalOf(ctx)
      )
    }
    return {
      value: ctx.builder.parameter(block, lineage, source.ordinal, declared.value),
      representation: declared.value
    }
  }
  if (source.kind === 'receiver') {
    // Same rule as a parameter: the carrier is normally the one the
    // convention declares, because that is what the caller pushed. A body
    // with no convention has no receiver at all, and reading one would
    // ordinarily invent a frame slot -- except for the one role
    // `semantics/normalize/producers/references.ts`'s `buildThisReference`
    // mints when it has already proven the read resolves to an *enclosing*
    // class's own instance: `this` inside an arrow, captured across the
    // function-object boundary that arrow's allocation crosses. That proof
    // lives in the operand's own role, not re-derived here: an ordinary,
    // undeclared `receiver` role still refuses exactly as it always has, and
    // only the producer-verified `captured-receiver` role derives a carrier
    // from the operand's own type -- the same field the enclosing class's own
    // receiver representation is itself derived from
    // (`representation/derive.ts`'s `signature.thisParameter`), so the two
    // agree by construction rather than by coincidence.
    const declared = ctx.abi?.receiver
    if (declared) return { value: ctx.builder.receiver(block, lineage, declared), representation: declared }
    if (operand.role === 'static-class-receiver') {
      const representation = ctx.constantDeriver.derive(operand.type)
      const declaration =
        representation.kind === 'constructor-family' && representation.members.length === 1 ? representation.members[0] : null
      if (!declaration) {
        throw new IrLoweringBlockedError(
          `${describeOperand(operand)} denotes a static block's class value, but its carrier is ` +
            `"${representationKey(representation)}" rather than one exact constructor-family`
        )
      }
      return {
        value: ctx.builder.allocateConstructor(block, lineage, declaration, [], representation),
        representation
      }
    }
    if (operand.role !== 'captured-receiver') {
      throw new IrLoweringBlockedError(
        `${describeOperand(operand)} reads the frame's receiver, which this body's calling convention does not declare` + abiRefusalOf(ctx)
      )
    }
    // The producer proved this is the enclosing class's own instance, so it is
    // that copy exactly, never the any-copy family union its type also names.
    const representation = ctx.constantDeriver.exactClassInstanceOf?.(operand.type) ?? ctx.constantDeriver.derive(operand.type)
    if (representation.kind === 'unresolved') {
      throw new IrLoweringBlockedError(
        `${describeOperand(operand)} captures the enclosing receiver, and no carrier is derivable for it: ${representation.reason}`
      )
    }
    return { value: ctx.builder.receiver(block, lineage, representation), representation }
  }
  const representation = ctx.constantDeriver.derive(operand.type)
  if (representation.kind === 'unresolved') {
    throw new IrLoweringBlockedError(`${describeOperand(operand)} has no derivable carrier: ${representation.reason}`)
  }
  return { value: ctx.builder.constant(block, lineage, source.text, source.literal, representation), representation }
}

export const resolveOptionalOperand = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand | undefined
): IrOperand | null => {
  if (!operand || operand.source.kind === 'absent') return null
  return resolveRequiredOperand(ctx, block, lineage, operand)
}

/**
 * Whether an operand names a result whose carrier is `void`.
 *
 * `void` is the carrier for "there is no value": a call that returns it mints
 * no SSA id at all (`build.ts`'s `mintOptionalResult`). So an operand naming
 * one cannot be resolved, and a consumer that can legitimately have nothing --
 * `return f()` in a `void` function, which C++ spells the same way -- has to
 * ask before resolving rather than be refused for a value that was correctly
 * never minted.
 */
export const namesVoidResult = (ctx: LoweringContext, operand: SemanticOperand | undefined): boolean =>
  operand?.source.kind === 'result' && ctx.plan.selected.get(operand.source.result)?.kind === 'void'

export const namedOperand = (operation: SemanticOperation, role: string, ordinal = 0): SemanticOperand => {
  const found = operandOf(operation, role, ordinal)
  if (!found) throw new IrLoweringBlockedError(`a ${operation.family} operation has no "${role}" operand to lower`)
  return found
}

export const orderedOperandsOf = (operation: SemanticOperation, role: string): readonly SemanticOperand[] =>
  operation.operands.filter((operand) => operand.role === role).sort((left, right) => left.ordinal - right.ordinal)

/** The one non-provenance operand of an operation that has exactly one, when no operand is explicitly named `value`. */
export const singleValueOperand = (operation: SemanticOperation): SemanticOperand => {
  const named = operandOf(operation, 'value', 0)
  if (named) return named
  const runtime = operation.operands.filter((operand) => operand.evaluation.kind !== 'provenance')
  const only = runtime.length === 1 ? runtime[0] : undefined
  if (only) return only
  throw new IrLoweringBlockedError(`a ${operation.family} operation has no unambiguous value operand to lower`)
}

export const requireLineage = (operation: SemanticOperation): SemanticResultId => {
  const anchor = anchorResultOf(operation)
  if (!anchor)
    throw new IrLoweringBlockedError(`a ${operation.family} operation published no semantic result for the IR to cite as lineage`)
  return anchor
}

export const optionalResultRepresentation = (
  ctx: LoweringContext,
  operation: SemanticOperation,
  role: ResultRole
): Representation | null => {
  const result = resultOf(operation, role)
  return result ? requireRepresentation(ctx.plan, result.id, `result ${result.id}`) : null
}

export const requireResultRepresentation = (
  ctx: LoweringContext,
  operation: SemanticOperation,
  role: ResultRole,
  describe: string
): Representation => {
  const result = resultOf(operation, role)
  if (!result) throw new IrLoweringBlockedError(`${describe} published no "${role}" result`)
  return requireRepresentation(ctx.plan, result.id, describe)
}

/** Registers the SSA id an operation's own IR lowering just produced under the same anchor `requireLineage` would cite for it. */
/**
 * A value in exactly the carrier a slot declares.
 *
 * The one place lowering converts. A consumer that needs an operand in its
 * slot's carrier asks here rather than converting on its own, so every
 * `convert` in the IR names a node of the conversion census -- the same node
 * the certificate checks and the printer renders -- and no consumer decides a
 * pair for itself. Identity is no conversion at all: the operand is handed
 * back untouched, so a slot that already agrees costs nothing in the IR.
 */
export const convertTo = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: IrOperand,
  slot: Representation,
  via = 'slot'
): IrOperand | null => {
  if (representationKey(operand.representation) === representationKey(slot)) return operand
  // The owner's own declaration asked for the projection; where the slot is
  // not exactly one arm the census answers `null` and the ordinary pair runs.
  const exact = ctx.exactArmNarrowing ? ctx.program.conversions.exactArmFor(operand.representation, slot) : null
  const node = exact ?? ctx.program.conversions.nodeFor(operand.representation, slot)
  if (node.capability.kind === 'never') return null
  const value = ctx.builder.convert(block, lineage, node.id, operand, slot)
  traceSpeculativeLoad(lineage, via, node, value)
  return { value, representation: slot }
}

/**
 * Diagnostic only, under `GEA_SPECULATIVE_LOADS`: every classifier-gated load
 * lowering minted, with the site that asked for it, so the loads no presence
 * or membership proof stands behind can be counted by site.
 */
export const speculativeLoads: {
  readonly lineage: SemanticResultId
  readonly via: string
  readonly node: ConversionNode
  readonly value: IrValueId
}[] = []
const tracingSpeculativeLoads = process.env.GEA_SPECULATIVE_LOADS !== undefined
const traceSpeculativeLoad = (lineage: SemanticResultId, via: string, node: ConversionNode, value: IrValueId): void => {
  if (tracingSpeculativeLoads && node.capability.kind === 'atom') speculativeLoads.push({ lineage, via, node, value })
}

/**
 * An operand as its consumer's slot wants it: resolved, then converted into
 * the slot's carrier when the census names one. A raw operand -- a key, a
 * callee, a condition, an argument to a host member the printer spells from
 * its own carrier -- is handed back as it arrived; so is an operand whose
 * pair the census cannot convert, which is recorded in `program.drift` and
 * left to the printer's own path (see `LoweringProgram.drift`).
 */
export const enter = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand
): IrOperand => {
  const answer = ctx.program.slots.slotOf(operation, operand)
  if (answer.kind === 'coerce') {
    // The census named an abstract operation, not a store: the node comes from
    // the coercion table, and a `never` there is drift the printer refuses by
    // name at the operator (no mixed-carrier spelling exists any more).
    const node = ctx.program.conversions.coercionFor(resolved.representation, answer.operation)
    if (node.capability.kind === 'identity') return resolved
    if (node.capability.kind === 'never') {
      recordDrift(ctx, block, operation.id, operand.role, operand.ordinal, resolved.representation, node.target, node)
      return resolved
    }
    return { value: ctx.builder.convert(block, lineage, node.id, resolved, node.target), representation: node.target }
  }
  if (answer.kind !== 'slot') return resolved
  const bound = bindDetachedMethod(ctx, block, lineage, resolved, answer.representation)
  if (bound !== null) return bound
  // An `alias` slot is a VIEW the consuming lowering builds itself -- an
  // object-source step's frozen view, an array pattern's cursor -- not a value
  // converted on the way in; converting here would hand the view builder a
  // value it then re-viewed.
  if (answer.source === 'alias') return resolved
  const caught = caughtHandoffEntry(ctx, block, lineage, operand, resolved, answer.representation)
  if (caught !== null) return caught
  const nullish = nullishOptionalArgumentEntry(ctx, block, lineage, operation, operand, resolved, answer.representation)
  if (nullish !== null) return nullish
  const unproven = unprovenArmEntry(ctx, block, lineage, operation, operand, resolved, answer.representation)
  if (unproven === 'refused') return resolved
  const entered =
    exactArmEntry(ctx, block, lineage, operation, operand, resolved, answer.representation) ??
    nativeBaseViewEntry(ctx, block, lineage, operand, resolved, answer.representation) ??
    unproven ??
    assertedUnionEntry(ctx, block, lineage, operation, operand, resolved, answer.representation) ??
    convertTo(ctx, block, lineage, resolved, answer.representation) ??
    familyMemberEntry(ctx, block, lineage, operation, operand, resolved, answer.representation) ??
    assertedArmEntry(ctx, block, lineage, operand, resolved, answer.representation) ??
    freshIntrinsicArrayEntry(ctx, block, lineage, operand, resolved, answer.representation)
  if (entered !== null) return entered
  recordDrift(ctx, block, operation.id, operand.role, operand.ordinal, resolved.representation, answer.representation)
  return resolved
}

/**
 * An argument entering an `@gea-exact-arms` callee's union slot through the
 * arm the resolved overload named (`ConversionRoleTarget.owner`'s
 * `exact-arm`): the value converted into THAT arm's carrier, then wrapped --
 * an exact wrap, since the arm's own key is one of the union's. `null` where
 * the call published no such role, the slot is not a union, or the named
 * type is not an arm of it, and the ordinary slot conversion runs instead.
 *
 * Two `convert`s rather than one so each names a census node the certificate
 * already knows how to read: source-into-arm is the same pair a direct call
 * of the overload would mint, and arm-into-union is the identity wrap.
 */
const exactArmEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (slot.kind !== 'tagged-union' || operand.role !== 'argument') return null
  const target = conversionRoleTargetOf(operation, 'argument', operand.ordinal, 'exact-arm')
  if (target === undefined) return null
  const arm =
    slot.arms.find((candidate) => candidate.semanticType === target.type) ??
    ((): TaggedUnionArm | undefined => {
      const key = representationKey(ctx.constantDeriver.layoutOf(target.type))
      return slot.arms.find((candidate) => representationKey(candidate.value) === key)
    })()
  if (arm === undefined) return null
  const held = convertTo(ctx, block, lineage, resolved, arm.value, 'exact-arm')
  return held === null ? null : convertTo(ctx, block, lineage, held, slot, 'exact-arm')
}

/**
 * A value the program's own type assertion states the arm of
 * (`SemanticOperand.asserted`), entering a slot that is exactly one arm of
 * its union, where the ordinary pair has no recipe: the census's exact-arm
 * projection, checked at runtime. Asked only AFTER `convertTo` declined, so
 * a pair the census answers soundly for every arm keeps that answer and the
 * assertion changes nothing -- exactly as it changes nothing in JavaScript.
 * The pair the census declines is the one where an arm has no home in the
 * slot at all (`conversions.ts`'s `classArmWithoutHome`): there the only
 * alternatives are refusing the program or reading the wrong arm's bytes,
 * and the author has written which arm it is.
 */
/**
 * A whole union entering a slot whose conversion SELECTS one of its arms,
 * where the operand's own type is still that whole union: nothing narrowed it,
 * so the checker proved no arm. TypeScript never lets a union reach one
 * member's slot unnarrowed; a census-built union does -- bson's
 * `makeFrame(sourceObject: Document)` holds `Document | any[] | Map | any`
 * because callers and guards put all four there, and `{ sourceObject }`
 * stores it into a `Document` field. The census's arm selection
 * (`gea::TaggedUnion::is`/`get`) trusts a narrowing that never happened, and
 * read an array's (or a box's) bytes as the dictionary.
 *
 * Where every arm reaches the slot, the load dispatches on the discriminant
 * and proves nothing it needs a narrowing for, so it proceeds; so does a slot
 * that is itself a union (a recast) or the box, and an `as T` operand (its
 * own checked projection, `assertedArmEntry`). Otherwise a slot that is
 * exactly one arm takes the checked exact-arm projection -- the value when it
 * is that arm, a TypeError otherwise -- and a selection with no such check is
 * refused.
 */
const unprovenArmEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | 'refused' | null => {
  const source = resolved.representation
  const union = source.kind === 'optional' ? source.payload : source
  if (union.kind !== 'tagged-union' || operand.asserted === true) return null
  const target = slot.kind === 'optional' ? slot.payload : slot
  if (target.kind === 'tagged-union' || target.kind === 'dynamic') return null
  if (representationKey(ctx.constantDeriver.derive(operand.type)) !== representationKey(source)) return null
  const capability = ctx.program.conversions.nodeFor(source, slot).capability
  const selects =
    (capability.kind === 'atom' &&
      capability.classifier.id === 'gea::TaggedUnion::is' &&
      capability.materializer.id === 'gea::TaggedUnion::get') ||
    (capability.kind === 'static' && capability.materializer.id === 'chain:narrowed-load')
  if (!selects) return null
  const uncovered = union.arms.find(
    (arm) =>
      representationKey(arm.value) !== representationKey(slot) &&
      ctx.program.conversions.nodeFor(arm.value, slot).capability.kind === 'never'
  )
  if (uncovered === undefined) return null
  const exact = exactArmIndexOf(source, slot) === null ? null : ctx.program.conversions.exactArmFor(source, slot)
  if (exact !== null) {
    const value = ctx.builder.convert(block, lineage, exact.id, resolved, slot)
    traceSpeculativeLoad(lineage, 'unproven-arm', exact, value)
    return { value, representation: slot }
  }
  const unproven: ConversionNode = {
    id: `${representationKey(source)}->${representationKey(slot)}#unproven-arm`,
    source,
    target: slot,
    capability: {
      kind: 'never',
      reason:
        `the operand is the whole union ${representationKey(source)}, never narrowed to the arm its conversion into ` +
        `${representationKey(slot)} selects; a census-built union reaches a single-carrier slot only where the slot can hold every arm, ` +
        `and arm ${representationKey(uncovered.value).slice(0, 200)} has no conversion into it (${uncoveredReason(ctx, uncovered.value, slot)})`
    }
  }
  recordDrift(ctx, block, operation.id, operand.role, operand.ordinal, source, slot, unproven)
  return 'refused'
}

const aliasProofsByGraph = new WeakMap<SemanticGraph, Map<string, boolean>>()

/** Operation forms whose result is a plain value (never the array itself) that a `return`/`throw` may carry out. */
const valueOnlyComputations: ReadonlySet<string> = new Set(['unary', 'binary', 'equality', 'typeof', 'instanceof', 'in'])

/**
 * Whether NO write to an array can be observed through a copy of it in the
 * body that makes the assertion: the element-wise rebuild of an `Array<any>`
 * arm yields a copy, and a copy diverges from the original the moment either
 * is written. Fail-closed and body-wide rather than per-array -- the body
 * performs no property write or delete, invokes nothing but carrier predicates
 * (so no callee can write either array, and no closure can run), allocates
 * nothing the array could be stored into, never suspends, and returns or throws
 * only plain computed values. Then the copy cannot outlive the body and nothing
 * inside it writes either side, so the two are indistinguishable.
 */
const bodyCannotObserveArrayAlias = (graph: SemanticGraph, at: SemanticOperation): boolean => {
  const owner = at.caller.kind === 'function' ? `f:${at.caller.functionId}` : `r:${at.caller.regionId}`
  const remembered = aliasProofsByGraph.get(graph)?.get(owner)
  if (remembered !== undefined) return remembered
  const sameCaller = (operation: SemanticOperation): boolean =>
    operation.caller.kind === at.caller.kind &&
    (operation.caller.kind === 'function'
      ? at.caller.kind === 'function' && operation.caller.functionId === at.caller.functionId
      : at.caller.kind === 'region' && operation.caller.regionId === at.caller.regionId)
  let proven = true
  for (const operation of graph.operations.values()) {
    if (!sameCaller(operation)) continue
    switch (operation.family) {
      case 'property':
        if (operation.internalMethod !== 'get' && operation.internalMethod !== 'has-property') proven = false
        break
      case 'invocation':
        if (operation.internalMethod !== 'call' || (operation.intrinsicCarrierPredicate !== true && operation.intrinsicOwnKeys !== true))
          proven = false
        break
      case 'binding':
      case 'reference':
      case 'boundary':
      case 'declaration-lifecycle':
      case 'destructuring':
      case 'protocol':
        if (operation.family === 'protocol' && operation.protocol !== 'iterator') proven = false
        break
      case 'computation':
        break
      case 'control': {
        if (operation.form === 'await' || operation.form === 'yield') proven = false
        if (operation.form === 'return' || operation.form === 'throw') {
          for (const carried of operation.operands) {
            if (carried.source.kind !== 'result') continue
            const producer = graph.operations.get(operationOfResult(carried.source.result))
            const plain =
              producer?.family === 'property' || (producer?.family === 'computation' && valueOnlyComputations.has(producer.form))
            if (!plain) proven = false
          }
        }
        break
      }
      default:
        proven = false
    }
    if (!proven) break
  }
  let table = aliasProofsByGraph.get(graph)
  if (table === undefined) aliasProofsByGraph.set(graph, (table = new Map()))
  table.set(owner, proven)
  return proven
}

/**
 * A whole union the program's own `as T` asserts to one carrier, where the
 * ordinary pair SELECTS an arm and some other arm has no conversion into the
 * slot. The assertion proves nothing about the live arm -- only a guard does,
 * and a guard is not an `asserted` operand -- so the selection's unchecked
 * `get<k>()` would read a live sibling arm as the selected one. The dispatch
 * node (`nodes.ts`'s `assertedUnionFor`) converts each arm that can be the
 * target and throws for one that cannot. A flow-proven narrowing never
 * reaches here: its operand is not `asserted`, and it keeps the unchecked load.
 */
const assertedUnionEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  const source = resolved.representation
  if (operand.asserted !== true || source.kind !== 'tagged-union') return null
  const capability = ctx.program.conversions.nodeFor(source, slot).capability
  const selects =
    (capability.kind === 'atom' &&
      capability.classifier.id === 'gea::TaggedUnion::is' &&
      capability.materializer.id === 'gea::TaggedUnion::get') ||
    (capability.kind === 'static' && capability.materializer.id === 'chain:narrowed-load')
  if (!selects) return null
  const slotKey = representationKey(slot)
  const uncovered = source.arms.some(
    (arm) => representationKey(arm.value) !== slotKey && ctx.program.conversions.nodeFor(arm.value, slot).capability.kind === 'never'
  )
  if (!uncovered) return null
  const node = ctx.program.conversions.assertedUnionFor(source, slot, bodyCannotObserveArrayAlias(ctx.graph, operation))
  if (node === null) return null
  const value = ctx.builder.convert(block, lineage, node.id, resolved, slot)
  traceSpeculativeLoad(lineage, 'asserted-union', node, value)
  return { value, representation: slot }
}

/** Why an arm has no conversion into a slot, as the conversion census states it. */
const uncoveredReason = (ctx: LoweringContext, arm: Representation, slot: Representation): string => {
  const capability = ctx.program.conversions.nodeFor(arm, slot).capability
  return capability.kind === 'never' ? capability.reason : capability.kind
}

/**
 * A `catch` clause's own binding, read where nothing else wrote it: the value
 * it holds is exactly what the `try` threw. Indexed once per graph -- the
 * writes of every declaration a binding operation names.
 */
const bindingWritesByGraph = new WeakMap<SemanticGraph, ReadonlyMap<string, readonly SemanticOperation[]>>()
const bindingWritesOf = (graph: SemanticGraph): ReadonlyMap<string, readonly SemanticOperation[]> => {
  const remembered = bindingWritesByGraph.get(graph)
  if (remembered !== undefined) return remembered
  const writes = new Map<string, SemanticOperation[]>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || (operation.action !== 'initialize' && operation.action !== 'write')) continue
    const list = writes.get(operation.declaration)
    if (list === undefined) writes.set(operation.declaration, [operation])
    else list.push(operation)
  }
  bindingWritesByGraph.set(graph, writes)
  return writes
}

const readsCaughtValue = (ctx: LoweringContext, operand: SemanticOperand): boolean => {
  if (operand.source.kind !== 'result') return false
  const read = ctx.graph.operations.get(operationOfResult(operand.source.result))
  if (read?.family !== 'binding' || read.action !== 'read') return false
  const writes = bindingWritesOf(ctx.graph).get(read.declaration) ?? []
  const only = writes.length === 1 ? writes[0] : undefined
  if (only?.family !== 'binding' || only.action !== 'initialize') return false
  const initializer = operandOf(only, 'initializer', 0)
  if (initializer?.source.kind !== 'result') return false
  const opener = ctx.graph.operations.get(operationOfResult(initializer.source.result))
  return opener?.family === 'boundary' && opener.boundary === 'exception-region'
}

/**
 * A caught value (`catch (error)`, typed `any`) handed to a class-typed slot:
 * the census's `caughtHandoffFor` read, which throws the value on when it is
 * not the class instead of aborting. See that node for the mongodb case.
 */
const caughtHandoffEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (resolved.representation.kind !== 'dynamic' || slot.kind !== 'class-ref') return null
  if (!readsCaughtValue(ctx, operand)) return null
  const node = ctx.program.conversions.caughtHandoffFor(resolved.representation, slot)
  if (node === null) return null
  return { value: ctx.builder.convert(block, lineage, node.id, resolved, slot), representation: slot }
}

/**
 * A property receiver the program asserts to a descendant class of the class
 * it holds (`properties.ts`'s `receiverIsAssertedClassArm`): the census's
 * checked class downcast, the one authority for both receivers. A union
 * receiver first selects its class arm through the checked exact-arm
 * projection (a TypeError on any other arm), then that arm's handle takes the
 * same downcast -- selecting the arm only distinguishes arms, so a plain base
 * object in the class arm would otherwise be stored through as the descendant.
 * `null` for any other receiver.
 */
export const assertedClassReceiver = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  view: Representation
): IrOperand | null => {
  if (operand.asserted !== true) return null
  let held = resolved
  let target = view
  if (resolved.representation.kind === 'tagged-union') {
    target = ctx.constantDeriver.derive(operand.type)
    if (target.kind !== 'class-ref') return null
    const wanted = target
    const arm = resolved.representation.arms.find(
      (candidate) =>
        candidate.value.kind === 'class-ref' &&
        candidate.value.ownership === wanted.ownership &&
        candidate.value.declaration !== wanted.declaration &&
        wanted.ancestors.includes(candidate.value.declaration)
    )
    if (arm === undefined) return null
    const selected = ctx.program.conversions.exactArmFor(resolved.representation, arm.value)
    if (selected === null) return null
    held = {
      value: ctx.builder.convert(block, lineage, selected.id, resolved, arm.value),
      representation: arm.value
    }
  }
  if (held.representation.kind !== 'class-ref') return null
  const node = ctx.program.conversions.assertedClassDowncastFor(held.representation, target)
  if (node === null) return null
  return { value: ctx.builder.convert(block, lineage, node.id, held, target), representation: target }
}

/** Whether a carrier has a `null` state of its own (a class reference's empty `Ref` is read separately). */
const holdsNull = (representation: Representation): boolean => {
  if (representation.kind === 'null' || representation.kind === 'dynamic') return true
  if (representation.kind === 'optional') return representation.absence === 'null' || holdsNull(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => holdsNull(arm.value))
  return false
}

/**
 * An `any` argument into an optional, undefaulted parameter whose payload
 * cannot hold `null`, of a callee that cannot tell that `null` from the
 * absence (`null-blind-parameter.ts`) -- see `nodes.ts`'s `nullishOptionalFor`. A class
 * reference payload is left to the ordinary read, whose empty `Ref` already
 * is that class's `null`.
 */
const nullishOptionalArgumentEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (operation.family !== 'invocation' || operand.role !== 'argument') return null
  if (resolved.representation.kind !== 'dynamic' || slot.kind !== 'optional' || slot.absence !== 'undefined') return null
  if (slot.payload.kind === 'class-ref' || holdsNull(slot.payload)) return null
  const parameter = operation.selectedSignature?.parameters[operand.ordinal]
  if (parameter === undefined || !parameter.optional || parameter.hasInitializer || parameter.rest || parameter.nullBlind !== true)
    return null
  const node = ctx.program.conversions.nullishOptionalFor(resolved.representation, slot)
  if (node === null) return null
  return { value: ctx.builder.convert(block, lineage, node.id, resolved, slot), representation: slot }
}

/**
 * An argument entering a parameter whose type names interface FAMILY members
 * (`semantics/interface-families.ts`), where the ordinary pair has no recipe:
 * the census's family-member view (`nodes.ts`'s `familyMemberViewFor`),
 * planned knowing which members the parameter's declared type names.
 *
 * mongodb's `WriteConcern.fromOptions(this.client.s.options)` is the shape:
 * `options?: WriteConcernOptions | WriteConcern | W`, whose record arm is the
 * family's one layout, holding the sibling `GridFSBucketWriteStreamOptions`'
 * `metadata?: Document` beside `writeConcern`. `MongoOptions` carries an
 * unrelated `metadata: Promise<ClientMetadata>`, which that field cannot hold
 * without boxing, so the pair -- keyed by carriers alone -- refuses: it cannot
 * tell this site from one naming the stream options, where leaving the field
 * out would read `undefined` for the promise. The parameter's own type says
 * which it is (`ConversionRoleTarget.owner`'s `parameter-slot`), and a member
 * that never declares `metadata` has no field to lose.
 *
 * Asked only after `convertTo` declined, so a pair the census converts keeps
 * its answer; a member the semantic layer could not key
 * (`familyMemberKeys` absent) leaves its layout unrestricted, and the pair
 * refuses exactly as before.
 */
const familyMemberEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (operand.role !== 'argument') return null
  const target = conversionRoleTargetOf(operation, 'argument', operand.ordinal, 'parameter-slot')
  if (target === undefined) return null
  const members = familyMembersNamedBy(ctx, target.type)
  if (members === null) return null
  const node = ctx.program.conversions.familyMemberViewFor(resolved.representation, slot, members)
  if (node === null) return null
  const value = ctx.builder.convert(block, lineage, node.id, resolved, slot)
  traceSpeculativeLoad(lineage, 'family-member-view', node, value)
  return { value, representation: slot }
}

/**
 * The keys each interface family layout's members declare, over every member
 * a type names -- through unions and union-bodied aliases, never into a
 * record's fields (those are the fields' own declared types, not this
 * site's). Keyed by the layout's carrier shape id, which is what a record
 * view's target names. `null` when the type names no keyed family member.
 */
const familyMembersNamedBy = (ctx: LoweringContext, type: StructuralTypeId): FamilyMemberKeys | null => {
  const keys = new Map<string, Set<string>>()
  const unkeyed = new Set<string>()
  const seen = new Set<StructuralTypeId>()
  const visit = (id: StructuralTypeId): void => {
    if (seen.has(id)) return
    seen.add(id)
    const shape = ctx.graph.structuralTypes.get(id)?.shape
    if (shape === undefined) return
    if (shape.kind === 'union') {
      for (const member of shape.members) visit(member)
      return
    }
    if (shape.kind !== 'declared' || shape.body === null) return
    const body = ctx.graph.structuralTypes.get(shape.body)?.shape
    if (body?.kind === 'union') {
      visit(shape.body)
      return
    }
    const carrier = ctx.constantDeriver.derive(id)
    if (carrier.kind !== 'native-record-ref' || carrier.native !== null) return
    // A name of the layout that states no keys -- a lone interface, or a
    // member the semantic layer could not key -- leaves it unrestricted.
    if (shape.familyMemberKeys === undefined) {
      unkeyed.add(carrier.shapeId)
      return
    }
    const held = keys.get(carrier.shapeId) ?? new Set<string>()
    for (const key of shape.familyMemberKeys) held.add(recordFieldKeyOf(key))
    keys.set(carrier.shapeId, held)
  }
  visit(type)
  for (const shapeId of unkeyed) keys.delete(shapeId)
  return keys.size === 0 ? null : keys
}

const assertedArmEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (operand.asserted !== true) return null
  const node = ctx.program.conversions.exactArmFor(resolved.representation, slot)
  if (node === null) return null
  const value = ctx.builder.convert(block, lineage, node.id, resolved, slot)
  traceSpeculativeLoad(lineage, 'asserted-arm', node, value)
  return { value, representation: slot }
}

/**
 * The array a native array's own `map`/`filter`/`slice`/... call just
 * allocated (`InvocationOperation.freshIntrinsicArrayResult`), entering a
 * slot of another element carrier: rebuilt once at the slot's element, as
 * `unsharedArrayRebuildOf` rebuilds a program body's fresh result. The
 * operand is the call's own result, consumed here and nowhere else, so no
 * other reference can observe the copy. mongodb's `insertMany` hands
 * `docs.map(doc => ({ insertOne: { document: doc } }))` -- an array of that
 * record -- to `bulkWrite(operations: ReadonlyArray<AnyBulkWriteOperation>)`.
 */
const freshIntrinsicArrayEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  const source = resolved.representation
  if (source.kind !== 'array-object' || slot.kind !== 'array-object') return null
  if (source.ownership !== slot.ownership || source.extension !== null || slot.extension !== null) return null
  if (operand.source.kind !== 'result') return null
  const producer = ctx.graph.operations.get(operationOfResult(operand.source.result))
  if (producer?.family !== 'invocation' || producer.freshIntrinsicArrayResult !== true) return null
  const receiver = operandOf(producer, 'receiver', 0)
  const held = receiver?.source.kind === 'result' ? ctx.plan.selected.get(receiver.source.result) : undefined
  if (held?.kind !== 'array-object' || held.extension !== null) return null
  const element = ctx.program.conversions.nodeFor(source.element, slot.element)
  if (element.capability.kind === 'never') return null
  return { value: ctx.builder.convert(block, lineage, element.id, resolved, slot, 'unshared-array'), representation: slot }
}

/**
 * A receiver read as the native collection its class extends, for a member
 * only that collection declares (`SemanticOperand.nativeBaseView`). Asked
 * BEFORE `convertTo`: the ordinary pair refuses a family that redeclares any
 * collection member, and this read is one the language itself answers with
 * the native member.
 */
/**
 * A property receiver read as the native collection its class extends
 * (`SemanticOperand.nativeBaseView`): the view the operand's own type names,
 * through the census's view node. `null` for any other receiver, which the
 * property lowering then views as it always has.
 */
export const nativeBaseReceiverView = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand
): IrOperand | null => nativeBaseViewEntry(ctx, block, lineage, operand, resolved, ctx.constantDeriver.derive(operand.type))

/**
 * An open `Document` iterated as the collection its `as` asserts: bson's
 * `for (const [key, value] of target as Map<string, unknown>)` under
 * `instanceof Map`. The Document can be that Map only by viewing it, so the
 * iterated value is the viewed object's checked read, refusing any other.
 */
export const assertedDocumentIterationView = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand
): IrOperand | null => {
  if (operand.asserted !== true || !isOpenDocument(resolved.representation)) return null
  return convertTo(ctx, block, lineage, resolved, ctx.constantDeriver.derive(operand.type), 'asserted-iteration')
}

/**
 * A receiver the program asserts to one native collection while the census
 * holds it as a sum with a boxed arm (`properties.ts`'s
 * `receiverIsAssertedCensusUnion`): bson's `(sourceObject as Map<unknown,
 * unknown>).entries()` under `instanceof Map`, where the boxed arm -- or a
 * Document arm viewing one -- may hold a Map too. Selecting the typed arm by
 * its tag would misread either, so each arm is converted: the typed arm as it
 * is, the box through its checked unbox, the Document through the object it
 * views (`nodes.ts`'s `armViewFor`).
 */
export const assertedCensusUnionReceiver = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  view: Representation
): IrOperand | null => {
  if (operand.asserted !== true || resolved.representation.kind !== 'tagged-union') return null
  const node = ctx.program.conversions.armViewFor(resolved.representation, view)
  if (node === null) return null
  const value = ctx.builder.convert(block, lineage, node.id, resolved, view)
  traceSpeculativeLoad(lineage, 'asserted-census-union', node, value)
  return { value, representation: view }
}

const nativeBaseViewEntry = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: SemanticOperand,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  if (operand.nativeBaseView !== true) return null
  const node = ctx.program.conversions.nativeBaseViewFor(resolved.representation, slot)
  if (node === null) return null
  const value = ctx.builder.convert(block, lineage, node.id, resolved, slot)
  traceSpeculativeLoad(lineage, 'native-base-view', node, value)
  return { value, representation: slot }
}

/** The row `LoweringProgram.drift` keeps for a pair the census has no recipe for. */
const recordDrift = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: OperationId,
  role: string,
  ordinal: number,
  source: Representation,
  slot: Representation,
  node: ConversionNode = ctx.program.conversions.nodeFor(source, slot)
): void => {
  ctx.program.drift.push({
    block,
    operation,
    role,
    ordinal,
    source: representationKey(source),
    slot: representationKey(slot),
    reason: node.capability.kind === 'never' ? node.capability.reason : node.capability.kind,
    sourceRepresentation: source,
    slotRepresentation: slot
  })
}

/**
 * A conversion the lowering itself decides on rather than one a slot asks
 * for -- a receiver's narrowed view, a dead merge arm's absence, the thrown
 * carrier, an omitted formal's `undefined`: the census node for the pair,
 * named on the `convert` instruction like every slot-driven conversion. A
 * pair the census cannot convert is recorded as drift under the given role
 * and STILL minted, because the consumer needs the value in `target` (a phi
 * arm, a `throw`) and the printer's own chain is what answers such a pair
 * until the census does. Every `convert` a lowering mints goes through here
 * or `convertTo`: a hand-built use id named a conversion no census had
 * counted, which is how a pair certified under one authority and refused
 * under another.
 */
export const convertOrDrift = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: OperationId,
  role: string,
  ordinal: number,
  operand: IrOperand,
  target: Representation,
  via = 'lowering'
): IrOperand => {
  const converted = convertTo(ctx, block, lineage, operand, target, via)
  if (converted !== null) return converted
  recordDrift(ctx, block, operation, role, ordinal, operand.representation, target)
  const node = ctx.program.conversions.nodeFor(operand.representation, target)
  return { value: ctx.builder.convert(block, lineage, node.id, operand, target), representation: target }
}

/**
 * A method value entering a receiver-less slot, bound to the object it was
 * read from -- the receiver converted into the convention's own receiver
 * carrier first, the way any receiver enters a frame. `null` when the pair is
 * not that, or when the value's origin is not a method read this body saw.
 */
const bindDetachedMethod = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  resolved: IrOperand,
  slot: Representation
): IrOperand | null => {
  const abi = detachedMethodAbiOf(resolved.representation, slot)
  if (abi === null || abi.receiver === null) return null
  const origin = ctx.program.methodValueReceivers.get(resolved.value)
  if (origin === undefined) return null
  const receiver = convertTo(ctx, block, lineage, origin.receiver, abi.receiver) ?? origin.receiver
  return {
    value: ctx.builder.bindCallable(block, lineage, resolved, origin.method, abi, null, receiver, [], slot, true),
    representation: slot
  }
}

/**
 * A method defined onto `holder` whose member slot declares no receiver,
 * bound to the holder (`BindCallableOperation.detached`'s `'holder'`). `null`
 * when the operand is not such a value, or the holder cannot enter the
 * method's own receiver carrier -- the ordinary `enter` then answers.
 */
export const bindInstalledMethod = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand,
  resolved: IrOperand,
  holder: IrOperand
): IrOperand | null => {
  const answer = ctx.program.slots.slotOf(operation, operand)
  if (answer.kind !== 'slot') return null
  const abi = detachedMethodAbiOf(resolved.representation, answer.representation)
  if (abi === null || abi.receiver === null) return null
  const receiver = convertTo(ctx, block, lineage, holder, abi.receiver)
  if (receiver === null) return null
  return {
    value: ctx.builder.bindCallable(block, lineage, resolved, null, abi, null, receiver, [], answer.representation, 'holder'),
    representation: answer.representation
  }
}

/**
 * A binding read in the carrier the plan selected for it, which is the cell's
 * own carrier or a narrowing of it: `x` read as `string` out of a cell placed
 * `optional(string)` behind the guard that proved it present. The read itself
 * yields the cell's carrier and the narrowing is a `convert` the conversion
 * census names, exactly as a store into the cell converts the other way. A
 * pair the census cannot convert is recorded as drift and the read is minted
 * in the selected carrier for the printer's own path to narrow.
 */
export const narrowedBindingRead = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  declaration: DeclarationId,
  representation: Representation
): IrValueId => {
  const placement = ctx.program.slots.input.placements.get(declaration)
  const storage = placement?.storage.kind
  const held = placement && (storage === 'local' || storage === 'region' || storage === 'external') ? placement.representation : null
  // `resolvedBinding` is the ONLY route a field's own declaration reaches a
  // binding read (`lower-property.ts`); an ordinary lexical variable's
  // declaration is never a key of `reactiveFieldDeclarations`, so this is a
  // no-op lookup for every other caller of this function.
  const reactive = ctx.program.reactiveFieldDeclarations.has(declaration)
  if (held === null || representationKey(held) === representationKey(representation)) {
    return ctx.builder.bindingRead(block, lineage, declaration, representation, reactive)
  }
  // A read the checker's control flow narrowed to exactly one arm of the
  // cell's union (`flowNarrowsType`), where the census has no sound per-arm
  // answer: the runtime-checked arm projection, as `assertedArmEntry` takes
  // for an `as T`.
  const pair = ctx.program.conversions.nodeFor(held, representation)
  const narrowed = pair.capability.kind === 'never' && operation.operands.some((operand) => operand.asserted === true)
  const node = (narrowed ? ctx.program.conversions.exactArmFor(held, representation) : null) ?? pair
  if (node.capability.kind === 'never') {
    recordDrift(ctx, block, operation.id, 'read', 0, held, representation)
    return ctx.builder.bindingRead(block, lineage, declaration, representation, reactive)
  }
  const raw = ctx.builder.bindingRead(block, lineage, declaration, held, reactive)
  const value = ctx.builder.convert(block, lineage, node.id, { value: raw, representation: held }, representation)
  traceSpeculativeLoad(lineage, 'read', node, value)
  return value
}

/** `resolveRequiredOperand` followed by `enter`, for the consumers whose operand is a value in a slot. */
export const enterRequiredOperand = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  operand: SemanticOperand
): IrOperand => enter(ctx, block, lineage, operation, operand, resolveRequiredOperand(ctx, block, lineage, operand))

export const registerResult = (ctx: LoweringContext, operation: SemanticOperation, value: IrValueId | null): void => {
  if (value === null) return
  const anchor = anchorResultOf(operation)
  if (anchor) ctx.values.set(anchor, value)
}

export { abiOfCallee, constructAbiOfCallee } from '../projection/callee.js'

/**
 * The named fields a record carrier lays out.
 *
 * A record type written inline (`function Row(props: {label: string})`) carries
 * its fields directly; one written as a named interface is carried *by name*,
 * because that is what makes a self-referential type finite -- so its layout
 * lives in the sealed structural table and is read back by deriving the shape
 * the reference names. Both are the same physical object; only the carrier
 * differs, and a lowering that handled just the first would refuse an ordinary
 * `interface RowProps` for no reason the program could act on.
 */
export const recordLayoutOf = (ctx: LoweringContext, props: Representation): readonly RecordField[] | null => {
  if (props.kind === 'record') return props.fields
  if (props.kind !== 'native-record-ref') return null
  const resolved = ctx.constantDeriver.layoutOf(props.shapeId as StructuralTypeId)
  return resolved.kind === 'record' ? resolved.fields : null
}

/**
 * A call's arguments with its variadic tail packed.
 *
 * A rest parameter is one slot holding an array, not a run of slots, so the
 * packing belongs where a call's operands are read rather than in each caller:
 * the convention states where the tail begins and which array carrier holds it,
 * and a convention that says a rest slot is not an array is refused rather than
 * packed into something that cannot hold it.
 */
/**
 * A call's arguments with its variadic tail packed.
 *
 * A rest parameter is one slot holding an array, not a run of slots, so the
 * packing belongs where a call's operands are read rather than in each caller:
 * the convention states where the tail begins and which array carrier holds it,
 * and a convention that says a rest slot is not an array is refused rather than
 * packed into something that cannot hold it.
 */
/**
 * One physical argument, and whether it is one value or a whole range.
 *
 * A `spread` slot carries the ENTIRE source array of a `f(a, ...xs)` call
 * (`producers/spread-arguments.ts` publishes it under its own operand role),
 * so it contributes however many elements that array holds -- which is a
 * runtime count. That is representable in exactly one place: inside the rest
 * array `packRestArguments` builds, as the same `spread` element an array
 * literal's own admitted spread already uses. A `spread` slot anywhere a
 * FIXED count is required has no rendering at all, and is refused.
 */
export type ArgumentSlot = { readonly kind: 'value' | 'spread'; readonly value: IrOperand; readonly from?: number }

export const packRestArguments = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: OperationId,
  abi: CallableAbi | null,
  passed: readonly ArgumentSlot[]
): readonly IrOperand[] => {
  let args: readonly ArgumentSlot[] = passed
  const firstSpread = args.findIndex((slot) => slot.kind === 'spread')
  if (!abi || abi.restFrom === null) {
    if (firstSpread >= 0) {
      throw new IrLoweringBlockedError(
        'a call range-copies a spread argument into a convention that declares no rest slot; a spread contributes a runtime number of ' +
          'values and there is no fixed formal for them to land in'
      )
    }
    return args.map((slot) => slot.value)
  }
  const slot = abi.parameters[abi.restFrom]
  if (!slot) {
    throw new IrLoweringBlockedError('a variadic convention declares no parameter at its own rest position and cannot be packed')
  }
  if (firstSpread >= 0 && firstSpread < abi.restFrom) {
    throw new IrLoweringBlockedError(
      `a call range-copies a spread argument at position ${firstSpread}, before this convention's rest slot at ${abi.restFrom}; ` +
        'only the rest tail can absorb a runtime number of values'
    )
  }
  // A call may pass fewer arguments than the convention names before its rest
  // slot -- `verifyProperty(obj, name, desc)` against `(obj, name, desc,
  // options, ...args)`, where the phantom tail exists only because the body
  // reads `arguments` -- and ECMA-262 10.2.1 binds each omitted formal to
  // `undefined`. The emitter pads an omitted formal for a convention with NO
  // rest slot (`paddedArguments`, emit-context.ts), but it identifies the rest
  // array positionally as the last argument, so the padding for a rest
  // convention has to happen here, before the tail is packed: each omitted
  // named slot is the language's literal `undefined`, converted into the
  // slot's own carrier by the same two steps `lower-short-circuit.ts` uses
  // for `??`'s absent arm, and a carrier that cannot hold the absence refuses
  // in that conversion rather than being default-constructed.
  const omitted: ArgumentSlot[] = []
  for (let position = args.length; position < abi.restFrom; position += 1) {
    const named = abi.parameters[position]
    if (!named) throw new IrLoweringBlockedError(`a variadic convention declares no parameter at named position ${position}`)
    const absent = ctx.builder.constant(block, lineage, 'undefined', 'undefined', { kind: 'undefined' })
    const converted = convertOrDrift(
      ctx,
      block,
      lineage,
      operation,
      'omitted',
      position,
      { value: absent, representation: { kind: 'undefined' } },
      named.value
    )
    omitted.push({ kind: 'value', value: converted })
  }
  if (omitted.length > 0) args = [...args, ...omitted]
  // A tuple carried as a positional record has a bounded field set.
  // Optional trailing positions may be omitted: leave those fields absent,
  // preserving the difference from a present argument whose value is undefined.
  if (isClosedContiguousTupleRecord(slot.value)) {
    const tail = args.slice(abi.restFrom)
    if (firstSpread >= 0) {
      throw new IrLoweringBlockedError(
        'a call range-copies a spread argument into a rest slot whose convention is a fixed-arity tuple, not a runtime-sized array; ' +
          'a spread contributes a runtime number of values and a tuple has no primitive to absorb one'
      )
    }
    if (tail.length > slot.value.fields.length) {
      throw new IrLoweringBlockedError(
        `a call passes ${tail.length} trailing argument(s) into a rest slot whose tuple convention declares ${slot.value.fields.length}; ` +
          'a fixed-arity rest slot and its call site have to agree on arity'
      )
    }
    const fields = slot.value.fields.flatMap((field, index) => {
      const entry = tail[index]
      if (!entry) {
        if (field.required)
          throw new IrLoweringBlockedError(`a tuple-shaped rest slot's required field ${index} has no matching trailing argument`)
        return []
      }
      return [{ key: field.key, value: entry.value }]
    })
    const packed = ctx.builder.allocateRecord(block, lineage, fields, slot.value)
    return [...args.slice(0, abi.restFrom).map((entry) => entry.value), { value: packed, representation: slot.value }]
  }
  if (slot.value.kind !== 'array-object') {
    throw new IrLoweringBlockedError('a variadic convention declares a rest slot that is not an array-object and cannot be packed')
  }
  // `slot` is captured by the element callback below; keep the narrowing in a
  // stable local rather than asking TypeScript to retain it through closure
  // control flow.  This is the same ABI-proved rest carrier, not a cast.
  const restArray = slot.value
  // The rest array is FRESH per call -- the language binds `...rest` to a new
  // Array, never to the caller's -- so a spread contributes a range copy into
  // it rather than aliasing it. That is also why a mixed `f(a, ...xs, b)`
  // needs no special case: the copy and the push are both just elements of the
  // array being built, in written order.
  const elements = args.slice(abi.restFrom).map((entry) => {
    // A positional element enters the pack's element slot the way a literal's
    // element enters an array literal's: converted here, so the printer's
    // folded push (`emit-arrays.ts`) and the packed array agree on the carrier.
    if (entry.kind !== 'spread')
      return { kind: 'element' as const, value: convertTo(ctx, block, lineage, entry.value, restArray.element) ?? entry.value }
    if (entry.value.representation.kind === 'dynamic') {
      if (restArray.element.kind !== 'dynamic') {
        throw new IrLoweringBlockedError(
          `a call gathers a dynamic iterator into a "${representationKey(restArray.element)}" rest element carrier; ` +
            'per-element dynamic conversion is not installed'
        )
      }
      return { kind: 'gather' as const, iterator: entry.value }
    }
    // Set/string/cursor range sources retain their existing emitter checks.
    // Only a dynamic iterator needs this dedicated materialization path.
    // A source carried wider than the rest element -- an open-ended tuple's
    // tail, whose array carries the union of every position -- converts per
    // element on the way in; the emitter installs the conversion from the
    // ordinary recipes and refuses by name where none exists.
    const converts =
      entry.value.representation.kind === 'array-object' &&
      representationKey(entry.value.representation.element) !== representationKey(restArray.element)
    return converts
      ? { kind: 'spread' as const, value: entry.value, from: entry.from ?? 0, element: restArray.element }
      : { kind: 'spread' as const, value: entry.value, from: entry.from ?? 0 }
  })
  const packed = ctx.builder.allocateArrayObject(block, lineage, elements, restArray)
  return [...args.slice(0, abi.restFrom).map((entry) => entry.value), { value: packed, representation: restArray }]
}
