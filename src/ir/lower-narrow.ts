import type { SemanticResultId } from '../identity/ids.js'
import {
  carriesMergeAbsence,
  carriesNoAbsence,
  carriesUndefined,
  contributesOnlyAbsence,
  contributesNoTruthiness,
  isBooleanShapedMergeTarget,
  isDeadMergeContribution,
  mergesAsTruthiness,
  partialDeadMergeArms,
  representationKey,
  type Representation
} from '../representation/model.js'
import { mergeFalsyAbsence, mergeMaterialization, mergeTaggedAbsence } from '../representation/merge.js'
import { operandOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { convertOrDrift, convertTo, resolveRequiredOperand, type LoweringContext } from './lower-operands.js'
import type { IrBlockId, IrOperand } from './model.js'

/**
 * A merge arm the census cannot bring into the merge's carrier blocks the
 * body. This is the certification of a merge: preflight used to rebuild
 * `mergeIncoming`'s decision tree over the semantic graph and refuse the
 * same pairs one stage earlier (`buildMergeNarrowingObligations`, deleted in
 * one authority for narrowing); with one authority left,
 * "no node" is a refusal here rather than a drift row the printer's own
 * chain would answer, because nothing downstream is entitled to decide it.
 */
const blockedMergeArm = (operation: SemanticOperation, role: string, from: Representation, to: Representation): IrLoweringBlockedError =>
  new IrLoweringBlockedError(
    `merge arm "${role}" of ${operation.family === 'computation' ? `${operation.form} ${'operator' in operation ? operation.operator : ''}`.trim() : operation.family}: ` +
      `no conversion is installed from ${representationKey(from)} into ${representationKey(to)}`
  )

/**
 * Every live arm of a rebuilt union must have somewhere to go: the merge's
 * own key, a census node, or -- for the `&&` rebuild only -- a boolean-shaped
 * merge, which `emitMergeLiveArmRebuild` renders by `ToBoolean`, total over
 * every carrier. The `??` rebuild admits no `ToBoolean` shortcut: its kept
 * branch proved the value PRESENT, and its payload arms are values, not
 * truthiness. The same two rules preflight's deleted `partialMergeArmsInstalled`
 * and `presentOptionalMergeInstalled` applied.
 */
const requireLiveArmsConvertible = (
  ctx: LoweringContext,
  operation: SemanticOperation,
  role: string,
  arms: readonly Representation[],
  merged: Representation,
  admitToBoolean: boolean
): void => {
  if (admitToBoolean && isBooleanShapedMergeTarget(merged)) return
  const mergedKey = representationKey(merged)
  for (const arm of arms) {
    if (representationKey(arm) === mergedKey) continue
    if (ctx.program.conversions.nodeFor(arm, merged).capability.kind === 'never') throw blockedMergeArm(operation, role, arm, merged)
  }
}

/**
 * One incoming value of a merge, in the carrier the merge publishes.
 *
 * A phi's incoming values must already carry the phi's own carrier
 * (`ir/verify.ts`), so wherever an arm does not, the carrier change is an
 * explicit instruction in *that arm's own block* rather than something the phi
 * assumes. `a ?? b` is the standing example: it keeps `a` on the branch where
 * `a` was proven present, and there the merge publishes the payload while the
 * operand still carries the optional.
 *
 * A constant whose declared type is uninhabited is materialized directly in the
 * merge's carrier instead. `never` is the checker's answer to "does control
 * reach here", not to "what storage does this value occupy", and the two part
 * company at exactly one idiom: `typeof X !== 'undefined' ? X : (undefined as
 * unknown as typeof X)`, the ambient-global guard. The false arm narrows to
 * `never` *because* the declared type excludes `undefined` -- yet that arm is
 * the one that runs whenever the host did not inject `X`. The value really is
 * absent and the merge is what states which carrier holds it, so the constant
 * is minted there; `cppConstantLiteral` then spells that carrier's absent value
 * or refuses outright if it has none.
 *
 * A *reference* whose declared type is inhabited can still be dead on this
 * one arm, the identical fact one step less literal: `a && a.b` keeps `a` on
 * the branch where `a` tested falsy, and when `a`'s own carrier is an Object
 * (a class instance, a record, a native reference, an array, a callable, ...)
 * it has no falsy state at all -- ECMAScript's `ToBoolean` never answers
 * `false` for one. Only `a`'s own absence, if it has one, can be why this
 * branch runs; the payload contributes nothing, exactly the way the
 * constant's `never` type contributes nothing above. `role === 'kept'` names
 * this arm precisely (`ir/lower.ts` passes it only for `&&`/`||`/`??`'s
 * reused side, never the freshly-evaluated one), `operator === '&&'` is the
 * one direction where the reachable state is falsy rather than truthy/
 * present, and `carriesMergeAbsence` is what the merge's own carrier must
 * satisfy for "materialize the absence" to have anywhere to land -- an
 * `optional`, or a `native-handle`, which `optional.ts` collapses `T | null`
 * onto precisely because it self-encodes absence -- and both it and
 * `contributesOnlyAbsence` are the facts this one authority asks; preflight's
 * `buildMergeNarrowingObligations` asked the same until Phase 1.6 deleted it.
 *
 * The operand's own null counts as that nothing. A bare
 * `class-ref(shared-refcount)` -- the collapsed form of `T | null` -- is the
 * one carrier whose falsy state is a value rather than a hole, and it is a
 * value the merge's absence already spells; `contributesOnlyAbsence` is the
 * whole-operand reading that admits it, where the per-arm
 * `isDeadMergeContribution` beside it must not.
 */
export const mergeIncoming = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: SemanticOperation,
  role: string,
  operand: SemanticOperand,
  representation: Representation
): IrOperand => {
  const materialization = mergeMaterialization(ctx.graph.structuralTypes, ctx.constantDeriver, operand, representation)
  if (materialization === 'constant' && operand.source.kind === 'constant') {
    return { value: ctx.builder.constant(block, lineage, operand.source.text, operand.source.literal, representation), representation }
  }
  if (materialization === 'absence') {
    // A tagged union can carry both absences; the arm that contributed
    // `undefined` (a `void` default, an uninhabited branch) must land in the
    // `undefined` arm, or `[w = c()]` on a short array prints `null`.
    const absence = representation.kind === 'optional' ? representation.absence : carriesUndefined(representation) ? 'undefined' : 'null'
    return { value: ctx.builder.constant(block, lineage, absence, absence, representation), representation }
  }
  // The same fact one step up from a scalar: an arm whose declared type is
  // uninhabited is materialized in the merge's carrier rather than converted
  // into it. `xs ? xs : []` is the standing idiom -- the checker types the
  // literal `never[]` and the conditional `T[]` -- and a conversion is the
  // wrong instruction for it in both directions: `array-object(undefined)` and
  // `array-object(T)` are different C++ types that cannot alias, so nothing
  // could reinterpret one as the other, and there is nothing to reinterpret
  // either, because an array of the uninhabited type is empty. The empty array
  // OF THE MERGE'S OWN ELEMENT TYPE is the whole value, so it is built here, in
  // this arm's own block, exactly as the constant above is.
  //
  // What this gives up is reference identity with the arm's own array, on the
  // one arm where nothing can observe it: two `never[]`s differ in no element,
  // no length and no future write, so only a `===` against the arm's own
  // binding could tell them apart -- and that arm previously did not lower at
  // all.
  if (representation.kind === 'array-object' && materialization === 'empty-array') {
    return { value: ctx.builder.allocateArrayObject(block, lineage, [], representation), representation }
  }
  // The same construction where the merge's carrier is a stated-native array
  // instead of an `ArrayObject`: `path.match(/\/:/g) || []` (hono's
  // `reg-exp-router/trie.ts:10` and `router.ts:132`) publishes
  // `gea::runtime::regex::MatchResult`, which IS an `ArrayObject<std::string>`
  // carrying 22.1.3.13's named members beside it. `mergeMaterialization` is
  // what proved the empty one is a complete value of that carrier; the
  // primitive is the record allocation an object/array literal with the same
  // carrier already lowers through (`ir/lower-allocation.ts`), with no fields,
  // because an empty array has none to install.
  if (representation.kind === 'native-record-ref' && materialization === 'empty-array') {
    return { value: ctx.builder.allocateRecord(block, lineage, [], representation), representation }
  }
  // An arm typed `never` (`Debug.fail()`) ran its own operations in its own
  // block and never completes; the phi still needs an incoming value from
  // that block, spelled as the dead `&&` arm below spells its own: an
  // `undefined` converted into the merge carrier, which `emit.ts` renders as
  // `gea::host::unreachableValue<T>()` when no load exists.
  if (materialization === 'unreachable') {
    const absent: Representation = { kind: 'undefined' }
    const dead = { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', absent), representation: absent }
    return convertOrDrift(ctx, block, lineage, operation.id, role, operand.ordinal, dead, representation)
  }
  const incoming = resolveRequiredOperand(ctx, block, lineage, operand)
  const from = representationKey(incoming.representation)
  const to = representationKey(representation)
  if (from === to) return incoming
  const falsyAbsence = mergeFalsyAbsence(incoming.representation, representation)
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '&&' &&
    falsyAbsence
  ) {
    return { value: ctx.builder.constant(block, lineage, falsyAbsence, falsyAbsence, representation), representation }
  }
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '&&' &&
    carriesMergeAbsence(representation) &&
    contributesOnlyAbsence(incoming.representation)
  ) {
    return { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', representation), representation }
  }
  // The kept operand has NO falsy state and the merge carries no absence for
  // one to land in: `previousSibling && format & Flag` on a present `Node`.
  // This branch never runs, and the checker already dropped the object from
  // the expression's type. The phi still needs an incoming value from the
  // block, so it gets the one thing a dead arm can honestly hold: an
  // `undefined` converted into the merge carrier, which `emit.ts`'s convert
  // renders as `gea::host::unreachableValue<T>()` when no load exists --
  // the same rendering a default past an empty tuple already gets. Licensed
  // by the identical predicate in `preflight/obligations-graph.ts`.
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '&&' &&
    isDeadMergeContribution(incoming.representation)
  ) {
    const absent: Representation = { kind: 'undefined' }
    const dead = { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', absent), representation: absent }
    return convertOrDrift(ctx, block, lineage, operation.id, role, operand.ordinal, dead, representation)
  }
  // The `||` mirror of the dead arm above: the kept operand has NO truthy
  // state (`contributesNoTruthiness`), so `a || b` never publishes it.
  // Licensed by the identical predicate in `preflight/obligations-graph.ts`.
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '||' &&
    contributesNoTruthiness(incoming.representation)
  ) {
    const absent: Representation = { kind: 'undefined' }
    const dead = { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', absent), representation: absent }
    return convertOrDrift(ctx, block, lineage, operation.id, role, operand.ordinal, dead, representation)
  }
  // The partial sibling of the whole-dead-arm bypass immediately above: SOME
  // of `incoming`'s tagged-union arms are dead rather than all of them --
  // `results[name]` typed `T[] | string`, where `T[]` (object-shaped, always
  // truthy) can never be why this `&&` fell through but `string` (an empty
  // one) can. `partialDeadMergeArms` states the split; `requireLiveArmsConvertible`
  // above is what certifies it (every live arm has a census node or the
  // merge is boolean-shaped), blocking the body otherwise. `MergeLiveArmRebuildOperation`
  // (`ir/model.ts`) is why this needs its own operation rather than the
  // general `convert` below: a dropped arm is sound only at a merge the
  // checker's own narrowing already proved it for, not everywhere the same
  // source/result pair recurs, so the proof travels as this operation's own
  // `liveArms`, computed once here and never re-derived at emission.
  const split = partialDeadMergeArms(incoming.representation)
  if (
    split &&
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '&&' &&
    (!split.keptIsOptional || carriesMergeAbsence(representation) || mergeTaggedAbsence(incoming.representation, representation) !== null)
  ) {
    requireLiveArmsConvertible(
      ctx,
      operation,
      role,
      split.liveIndices.flatMap((index) => (split.payload.arms[index] ? [split.payload.arms[index].value] : [])),
      representation,
      true
    )
    return {
      value: ctx.builder.mergeLiveArmRebuild(
        block,
        lineage,
        incoming,
        representation,
        split.liveIndices,
        split.keptIsOptional,
        ctx.program.conversions
      ),
      representation
    }
  }

  // `a ?? b` reaches its kept branch only after the presence test succeeded.
  // When `a` is `Optional<TaggedUnion<...>>`, that proof removes the optional
  // wrapper's absence while preserving every payload arm. Rebuild the live
  // payload into the merge carrier at this site rather than installing the
  // unsound global conversion `optional(T) -> U`, which would have no answer
  // for absence at unguarded occurrences of the same pair.
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '??' &&
    incoming.representation.kind === 'optional' &&
    incoming.representation.payload.kind === 'tagged-union'
  ) {
    requireLiveArmsConvertible(
      ctx,
      operation,
      role,
      incoming.representation.payload.arms.map((arm) => arm.value),
      representation,
      false
    )
    return {
      value: ctx.builder.mergeLiveArmRebuild(
        block,
        lineage,
        incoming,
        representation,
        incoming.representation.payload.arms.map((_, index) => index),
        false,
        ctx.program.conversions
      ),
      representation
    }
  }

  // A `&&` whose merged type is a plain `boolean`: the kept operand is here
  // only as its own truthiness, which is the very question `&&` asked of it.
  // `object && object.isObject3D` over three's `Object3D` is the shape -- the
  // checker collapsed the whole expression to `boolean`, so no VALUE of the
  // kept operand survives to be converted, only its `ToBoolean`.
  // `mergesAsTruthiness` is the identical fact
  // `preflight/obligations-graph.ts` licenses this with, and the `test`
  // operation renders through `emit-presence.ts`'s `booleanTestText`, which
  // is total over every carrier -- including a nullable `class-ref`, whose
  // truthiness is exactly its presence.
  //
  // LAST of the three, on purpose. The whole-dead bypass above materializes an
  // absence where the merge has somewhere to hold one, and the partial-arm
  // rebuild converts each still-live arm on its own; both are strictly more
  // precise than one `ToBoolean` over the operand, and both already covered
  // the programs that reach them. This answers only what neither did.
  if (
    role === 'kept' &&
    operation.family === 'computation' &&
    operation.form === 'logical' &&
    operation.operator === '&&' &&
    mergesAsTruthiness(representation)
  ) {
    return { value: ctx.builder.test(block, lineage, incoming), representation }
  }
  // Which arms the merge's own test proves present: `a || b` and `a ?? b`
  // keep `a` only when it is truthy or non-nullish, and a default keeps its
  // extraction only past the `is-defined` guard. A conditional's arm, or the
  // falsy operand `&&` keeps, is chosen by something else.
  const guarded =
    (operation.family === 'computation' &&
      operation.form === 'logical' &&
      (operation.operator === '||' || operation.operator === '??') &&
      role === 'kept') ||
    (operation.family === 'destructuring' && operation.form === 'default-value' && role === 'extracted')
  const converted = convertTo(ctx, block, lineage, incoming, representation, guarded ? 'guard' : 'merge-arm')
  if (converted !== null) return converted
  // The general form of the `optional(tagged-union)` rebuild above, and the
  // last thing asked rather than the first: a guarded arm whose payload -- not
  // the optional around it -- is what the merge's carrier accepts.
  //
  // `(options?.onError ?? console.error)(e)` (node-server's `websocket.ts`) is
  // the standing shape. TypeScript reduces the merged type to `console.error`'s
  // own `(...data: any[]) => void`, because the positional handler really is
  // assignable to it, so the merge publishes that one frame; the kept operand
  // still carries `optional((any) => void)` because that is what the FIELD
  // holds. Both halves are already installed as census nodes -- the presence
  // load `optional(T) -> T`, and `T -> U`, the callable adapter a conditional
  // between the same two functions already lowers through -- and the pair
  // `optional(T) -> U` is not, deliberately: it has no answer for absence at
  // the unguarded occurrences of the same pair, which is precisely why the
  // rebuild above refuses to install it globally.
  //
  // What licenses composing them here is `guarded`, already computed above:
  // `??` reached this branch past a nullish test, `||` past a truthiness test
  // (an absent optional is falsy, so truthy proves present too), and a
  // destructuring default past its own `is-defined` guard. The presence is the
  // branch's, so the unwrap is branch-local -- the same thing the constant and
  // empty-array materializations above are -- and neither step is a new
  // capability.
  if (guarded && incoming.representation.kind === 'optional') {
    const present = convertTo(ctx, block, lineage, incoming, incoming.representation.payload, 'guard')
    const widened = present === null ? null : convertTo(ctx, block, lineage, present, representation, 'merge-arm')
    if (widened !== null) return widened
  }
  // The `??` mirror of the dead KEPT arms above, on the other side of the
  // operator: `a ?? b` evaluates `b` only where `a` was nullish, and a kept
  // operand whose carrier has no absent state at all was never nullish, so this
  // arm never runs.
  //
  // node-server's `websocket.ts` module body is the shape:
  // `globalThis.CloseEvent ?? class extends Event {...}`, where the program's
  // own global read carries a bare `constructor-family`. The fallback class is
  // a SECOND, unrelated program class, and the conversion asked for between the
  // two is a nominal identity C++ has no way to state -- which is the right
  // refusal for a value this arm never produces.
  //
  // Asked LAST, after the ordinary conversion has already been tried and
  // failed, for the same reason `mergesAsTruthiness` above is: an arm that
  // really does convert keeps converting, so this only ever turns a refusal
  // into the dead value, never a working merge into one.
  if (role === 'taken' && operation.family === 'computation' && operation.form === 'logical' && operation.operator === '??') {
    const kept = operandOf(operation, 'left')
    const keptCarrier = kept?.source.kind === 'result' ? ctx.plan.selected.get(kept.source.result) : undefined
    if (keptCarrier && carriesNoAbsence(keptCarrier)) {
      const absent: Representation = { kind: 'undefined' }
      const dead = { value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', absent), representation: absent }
      return convertOrDrift(ctx, block, lineage, operation.id, role, operand.ordinal, dead, representation)
    }
  }
  throw blockedMergeArm(operation, role, incoming.representation, representation)
}
