import type { DeclarationId, FunctionId, OperationId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import { classLayoutOfCopy, type ClassLayout } from '../projection/classes.js'
import type { SlotCensus } from '../projection/slots.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { operationOfResult, physicalBodyId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type {
  BindingOperation,
  ClassLifecycleOperation,
  ComputationOperation,
  ControlOperation,
  SemanticOperation
} from '../semantics/model/operations.js'
import { createIrBodyBuilder } from './build.js'
import {
  collectConditionalMembership,
  groupOperationsByOwner,
  IrLoweringBlockedError,
  orderOwnerOperations,
  collectRegionParts,
  type RegionPartMembers,
  type OwnerId
} from './lower-graph.js'
import type { SemanticEdge } from '../semantics/model/edges.js'
import { completionTargetOf, findCompletionTargetBlock } from './lower-completion.js'
import { lowerBoundary, thrownValueCarrier } from './lower-exceptions.js'
import { mergeIncoming } from './lower-narrow.js'
import { settleShortCircuits } from './lower-short-circuit.js'
import { lowerDestructuring } from './lower-destructuring.js'
import { lowerElement } from './lower-element.js'
import { lowerInvocation } from './lower-invocation.js'
import { lowerAllocation } from './lower-allocation.js'
import { lowerProperty } from './lower-property.js'
import { lowerProtocol } from './lower-protocol.js'
import type { PluginInstance } from '../plugins/model.js'
import { createFlowController, type FlowController } from './lower-flow.js'
import {
  namesVoidResult,
  namedOperand,
  optionalResultRepresentation,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveOptionalOperand,
  resolveRequiredOperand,
  resolveResultValue,
  singleValueOperand,
  abiOfCallee,
  type LoweringContext,
  convertOrDrift,
  enter,
  narrowedBindingRead,
  enterRequiredOperand,
  type LoweringProgram,
  type SlotDrift
} from './lower-operands.js'
import { allOperationsOf, type IrBlock, type IrBlockId, type IrBody, type IrIteratorCloseRegion } from './model.js'

/**
 * Lowering a sealed `SemanticGraph` plus a `SealedRepresentationPlan` into
 * verified `IrBody` values, one per executable owner.
 *
 * Every mapping here is deliberately narrow: `property`/`invocation`/the
 * sync-iterator steps of `protocol` map onto the object-substrate IR because
 * that IR exists for them; almost everything else -- arithmetic, `for`/`try`,
 * destructuring, class lifecycle -- has no IR primitive yet
 * (`docs/ARCHITECTURE.md`, "Not built": "the typed IR model exists; the
 * semantic-graph -> IR -> C++ document path does not"), so lowering it would
 * mean inventing one here, off to the side of whatever `ir/model.ts` actually
 * declares. Blocking with a stated missing capability is the honest answer;
 * the alternative is a compiler stage with its own private opinion about what
 * the IR contains.
 */

export interface IrLoweringInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  /**
   * The very deriver that produced `plan`, not an equivalent one.
   *
   * A published result's carrier is read from `plan.selected`; an
   * `OperandSource.constant` is inline data that was never published, so no
   * row is keyed by it and its carrier has to be derived. Deriving it from a
   * *separately constructed* deriver is what made this a second authority:
   * built with default policies it answers `native-record-ref` where the plan
   * answers `typed-array(float32)` or `native-handle`, for the same
   * `StructuralTypeId`. Taking the plan's own deriver means "not in the plan"
   * costs a lookup, never a different opinion.
   */
  readonly deriver: RepresentationDeriver
  /** Each function's calling convention, projected once before any body lowers. */
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  /** The second convention into a body that is both called and `new`ed (`projection/abi.ts`'s `constructs`). */
  readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
  /** Exact callable provenance projected from the semantic graph. */
  readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
  /** Callable own-property mutations that make `.call`/`.apply` rewrites unsafe. */
  readonly callableOwnPropertyWrites: ReadonlyMap<FunctionId, ReadonlySet<string>>
  readonly functionPrototypePropertyWrites: ReadonlySet<string>
  /** Why the projection refused a convention, for the functions it refused, so a body can report the cause instead of the symptom. */
  readonly abiBlockers: ReadonlyMap<FunctionId, string>
  /** What each class is made of, projected once before any body lowers. */
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly slots: SlotCensus
  readonly conversions: ConversionCensus
  /**
   * Installed plugins, consulted before this file's own lowering for every
   * operation.
   *
   * They come first, not last, and the difference matters. A plugin that gives
   * a construct new meaning has to replace what the language alone would do
   * with it, not patch up the leftovers -- and a fallback ordering would mean a
   * plugin could only ever claim what the core had already refused, which is
   * every construct the core got *wrong* for that library and none of the ones
   * it got merely incompletely.
   */
  readonly plugins: readonly PluginInstance[]
}

export interface IrLoweringBlocker {
  readonly owner: OwnerId
  readonly reason: string
}

export interface IrLoweringResult {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly blocked: readonly IrLoweringBlocker[]
  /** Slots lowering could not fill from the census -- see `LoweringProgram.drift`. */
  readonly slotDrift: readonly SlotDrift[]
}

/**
 * Arithmetic, bitwise, relational, and the unary operators.
 *
 * Only `unary`/`binary` reach a primitive. The other forms the computation
 * family publishes are not operators over evaluated operands at all: `logical`
 * and `conditional` select without evaluating one side, `template` and
 * `coercion` need conversions, `update` and `assignment` write a binding, and
 * `typeof`/`instanceof`/`in` interrogate the object substrate. Each of those is
 * its own missing primitive, named as such rather than folded into this one.
 */
const lowerComputation = (ctx: LoweringContext, flow: FlowController, block: IrBlockId, operation: ComputationOperation): void => {
  // An assignment expression's own value is the value it assigned, and a comma
  // expression's is its last operand's. Neither computes anything: the write
  // and the operands are already operations of their own, so minting an IR
  // instruction here would be a second copy of a value already in hand.
  if (operation.form === 'assignment' || operation.form === 'comma') {
    const lineage = requireLineage(operation)
    const runtime = operation.operands.filter((operand) => operand.evaluation.kind !== 'provenance')
    const last = runtime[runtime.length - 1]
    if (!last) throw new IrLoweringBlockedError(`a ${operation.form} computation has no operand to take its value from`)
    // ...through `mergeIncoming`, which is the identical question a merge arm
    // asks: the value is the operand's, and the carrier is the one the plan
    // published for THIS operation. The two part company at an erased
    // assertion -- `x = e as T` evaluates to the assertion's type while `e`
    // still carries its own -- and registering the operand's SSA under a
    // result the plan gave a different carrier is one value wearing two
    // carriers, which `ir/verify.ts` rejects (correctly) with a message that
    // names neither the assertion nor the assignment. So the carrier change
    // is an explicit conversion here, rendered by the one authority on what a
    // carrier change loads, and refused by name at emission if that authority
    // has no load for the pair.
    const representation = requireResultRepresentation(ctx, operation, 'value', `a ${operation.form} computation`)
    registerResult(ctx, operation, mergeIncoming(ctx, block, lineage, operation, 'value', last, representation).value)
    return
  }
  // ToNumeric over a value the plan already carries as a number is the identity
  // conversion: the language's step runs, and its answer is the operand. Minting
  // an instruction would copy a value already in hand; registering the operand
  // is what keeps one value with one name.
  //
  // One non-identity pair IS a real primitive, minted as an ordinary `unary`
  // compute instruction rather than a new `ComputeOperation.form` (`ir/
  // model.ts` is unchanged): postfix `x++`/`x--`'s own coercion
  // (`semantics/normalize/producers/computations.ts`'s `contributeUpdate`,
  // the ONLY producer that ever mints `form: 'coercion'`, and always with
  // `operator: 'ToNumeric'`) over a `dynamic` operand landing on
  // `scalar(number)` -- three.js's `let i` / an untyped loop counter
  // incremented with `++`. `targets/cpp/emit.ts`'s `emitCompute` renders it
  // (operator `'ToNumeric'`, checked before the ordinary numeric-unary table)
  // via `targets/cpp/emit-tonumber.ts`'s `dynamicToNumericText`, which
  // switches on the boxed value's own runtime tag -- see that function's own
  // comment for why this is a real per-tag ToNumber and not the "assert one
  // declared tag" narrowing `emit-narrowing.ts` already has.
  //
  // An `optional` operand landing on `scalar(number)` is a second, unrelated
  // non-identity pair: `l[1]!++` under `noUncheckedIndexedAccess` cites the
  // element access's own `[[Get]]`, which honestly publishes `T | undefined`
  // regardless of the `!` outside it (the assertion is a compile-time promise,
  // not a narrower runtime read) -- so the operand this coercion sees really is
  // optional, the same shape a mixed-carrier `+`'s own ToNumber operand can be
  // (`projection/slots.ts`'s `binarySlot`). That sibling already resolves
  // through `ir/lower-operands.ts`'s `enter`/`convertTo`, which asks the
  // conversion census's `coercionFor` for a `ToNumber` node and gets a REAL one
  // back: `targets/cpp/emit-tonumber.ts`'s `toNumberText` renders an
  // `optional` source as `has_value() ? number : NaN`, ECMA-262 7.1.4's own
  // answer for `Number(undefined)`. `l[1]! += 5` already takes exactly that
  // path (`computations.ts`'s compound-assignment operand), so `l[1]!++`
  // refusing here was one operation asking the shared census a question its
  // sibling operation already asks and already gets answered -- not a missing
  // capability, a missing call. This form never went through `enter` at all
  // (`projection/slots.ts` deliberately routes `'coercion'`/`'update'` to
  // `raw('compute-operand')`, since ONLY this ToNumeric case ever needs a real
  // conversion here), so the call is made directly rather than through `enter`.
  // A BigInt operand stays refused: `coercionFor` reports `never` for it
  // (`emit-tonumber.ts`'s `toNumberText` returns `null` for `domain ===
  // 'bigint'`, matching ECMA-262's own TypeError for `ToNumber` of a BigInt),
  // which is the same silent-nothing this branch already left alone before --
  // no fail-open coercion is added, only the one ECMA-262 already states as
  // total for a possibly-absent Number.
  //
  // Every other non-identity pair is still a real conversion this layer has no
  // primitive for, and stays refused by name.
  if (operation.form === 'coercion') {
    const lineage = requireLineage(operation)
    const runtime = operation.operands.filter((operand) => operand.evaluation.kind !== 'provenance')
    const only = runtime[0]
    if (!only || runtime.length !== 1) {
      throw new IrLoweringBlockedError(`a coercion with ${runtime.length} operand(s) has no IR primitive`)
    }
    const resolved = resolveRequiredOperand(ctx, block, lineage, only)
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a coercion computation')
    if (representationKey(resolved.representation) === representationKey(representation)) {
      registerResult(ctx, operation, resolved.value)
      return
    }
    if (
      operation.operator === 'ToNumeric' &&
      resolved.representation.kind === 'dynamic' &&
      representation.kind === 'scalar' &&
      representation.domain === 'number'
    ) {
      registerResult(ctx, operation, ctx.builder.compute(block, lineage, 'unary', 'ToNumeric', [resolved], representation))
      return
    }
    if (operation.operator === 'ToNumeric' && representation.kind === 'scalar' && representation.domain === 'number') {
      const node = ctx.program.conversions.coercionFor(resolved.representation, 'ToNumber')
      if (node.capability.kind === 'identity') {
        registerResult(ctx, operation, resolved.value)
        return
      }
      if (node.capability.kind !== 'never') {
        registerResult(ctx, operation, ctx.builder.convert(block, lineage, node.id, resolved, node.target))
        return
      }
    }
    throw new IrLoweringBlockedError(
      `no IR primitive performs "${operation.operator}" from ${representationKey(resolved.representation)} ` +
        `to ${representationKey(representation)}`
    )
  }
  // `?:` evaluates exactly one arm, so its value is a merge, not an operator
  // over two evaluated operands. The arms already ran in their own blocks --
  // the conditional edges the producer published put them there -- and this
  // runs unconditionally, which means the flow controller has already closed
  // both arms into the join by the time it reaches here.
  // `a && b` and `a || b` are the same merge as `?:` with the guard doubling as
  // one of the arms: `a && b` is `a` on the falsy side and `b` on the truthy
  // one.
  //
  // `a ?? b` is the same merge again, over a different question: presence, not
  // truth -- `0 ?? 1` is `0` where `0 || 1` is `1` -- and `branchArmOf`
  // (lower-flow.ts) already carries that on the test rather than the branch, so
  // the kept side is `sources.truthy` exactly as for `||`. Only the carrier
  // differs, and `mergeIncoming` makes that unwrap an explicit conversion
  // rather than something the phi assumes.
  if (operation.form === 'logical' && (operation.operator === '&&' || operation.operator === '||' || operation.operator === '??')) {
    const lineage = requireLineage(operation)
    const left = namedOperand(operation, 'left')
    if (left.source.kind !== 'result') throw new IrLoweringBlockedError('a logical computation has no guard result to merge over')
    const sources = flow.requireMergeSources(left.source.result)
    const shortCircuit = operation.operator === '&&' ? sources.falsy : sources.truthy
    const evaluated = operation.operator === '&&' ? sources.truthy : sources.falsy
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a logical computation')
    // Same as the conditional below: a merge whose carrier is `void` has no
    // value to merge.
    if (representation.kind === 'void') return
    const incoming = [
      { block: shortCircuit, value: mergeIncoming(ctx, shortCircuit, lineage, operation, 'kept', left, representation) },
      {
        block: evaluated,
        value: mergeIncoming(ctx, evaluated, lineage, operation, 'taken', namedOperand(operation, 'right'), representation)
      }
    ]
    registerResult(ctx, operation, ctx.builder.phi(sources.join, lineage, incoming, representation))
    return
  }
  if (operation.form === 'conditional') {
    const lineage = requireLineage(operation)
    const guard = namedOperand(operation, 'condition').source
    if (guard.kind !== 'result') throw new IrLoweringBlockedError('a conditional computation has no guard result to merge over')
    const sources = flow.requireMergeSources(guard.result)
    // Each arm's value is materialized in that arm's own block: a constant
    // placed in the join would be an incoming value the predecessor never had.
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a conditional computation')
    // `cond ? f() : g()` where both calls return `void` merges nothing: `void`
    // is the carrier for "there is no value", so neither arm minted an SSA name
    // and a phi here would merge two names nobody wrote. The branch itself is
    // already built -- the flow controller opened and closed both arms from the
    // conditional edges the producer published -- and the arms' own operations
    // ran inside them. What is left is only the value, and there is none.
    if (representation.kind === 'void') return
    const consequent = mergeIncoming(
      ctx,
      sources.truthy,
      lineage,
      operation,
      'consequent',
      namedOperand(operation, 'consequent'),
      representation
    )
    const alternate = mergeIncoming(
      ctx,
      sources.falsy,
      lineage,
      operation,
      'alternate',
      namedOperand(operation, 'alternate'),
      representation
    )
    registerResult(
      ctx,
      operation,
      ctx.builder.phi(
        sources.join,
        lineage,
        [
          { block: sources.truthy, value: consequent },
          { block: sources.falsy, value: alternate }
        ],
        representation
      )
    )
    return
  }
  // `k in o` is `[[HasProperty]]` -- ECMA-262 13.10.1 step 7 names the internal
  // method outright -- so it lowers to the same IR primitive a property access
  // uses rather than to a compute form of its own. One primitive means one
  // renderer: a receiver that owns a runtime property table answers from that
  // table, a closed layout answers from its own required fields, and neither
  // spelling can drift from the other because there is only one.
  //
  // The operand roles are the operator's, not the internal method's, and they
  // are the reverse of each other: `in`'s LEFT operand is the key and its RIGHT
  // is the object. They are resolved by role rather than by position so that
  // reversal is stated once, here, instead of being re-derived by every reader
  // of a two-operand list.
  if (operation.form === 'in') {
    const lineage = requireLineage(operation)
    const key = operandOf(operation, 'left')
    const receiver = operandOf(operation, 'right')
    if (!key || !receiver) throw new IrLoweringBlockedError('an "in" computation is missing its key operand or its object operand')
    const representation = requireResultRepresentation(ctx, operation, 'value', 'an "in" computation')
    registerResult(
      ctx,
      operation,
      ctx.builder.hasProperty(
        block,
        lineage,
        resolveRequiredOperand(ctx, block, lineage, receiver),
        resolveRequiredOperand(ctx, block, lineage, key),
        representation
      )
    )
    return
  }
  // `void x` is the one operator that never READS its operand: it orders the
  // operand's evaluation and then yields `undefined` (ECMA-262 13.5.2). The
  // evaluation is already the operand's own operation in this graph, so all
  // that is left here is the constant -- and that matters for `void f()` where
  // `f` returns nothing, because `void` is the carrier for "there is no value"
  // and `build.ts` mints no SSA name for one. Citing that operand would be
  // asking for a name nobody wrote; the operator's answer is `undefined`
  // either way, so it is dropped rather than resolved. This is the same
  // question `return f()` already asks in a `void` function, asked by the same
  // predicate, so the two cannot drift.
  if (operation.form === 'unary' && operation.operator === 'void') {
    const lineage = requireLineage(operation)
    const discarded = namedOperand(operation, 'operand')
    const operands = namesVoidResult(ctx, discarded) ? [] : [resolveRequiredOperand(ctx, block, lineage, discarded)]
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a unary "void" computation')
    registerResult(ctx, operation, ctx.builder.compute(block, lineage, 'unary', 'void', operands, representation))
    return
  }
  // `typeof` and `template` join the operator forms rather than getting paths
  // of their own: each takes its evaluated operands and produces one value,
  // which is exactly the shape this tail already lowers. What they *render* as
  // differs -- a constant for most `typeof`s, a concatenation for a template --
  // but that is the target's answer to give, not this layer's.
  if (
    operation.form !== 'unary' &&
    operation.form !== 'binary' &&
    operation.form !== 'update' &&
    operation.form !== 'equality' &&
    operation.form !== 'typeof' &&
    operation.form !== 'instanceof' &&
    operation.form !== 'template'
  ) {
    throw new IrLoweringBlockedError(`no IR primitive lowers a computation of form "${operation.form}"`)
  }
  const lineage = requireLineage(operation)
  // A compute operand is raw for every form but one: a mixed-carrier
  // `binary` operator's operands are coerced (ToNumber/ToString, 13.15.3 and
  // 7.2.13) before the operator runs, and the slot census states which
  // (`projection/slots.ts`'s `binarySlot`), so they enter like any slot.
  const operands = operation.operands
    .filter(
      (operand) => operand.evaluation.kind !== 'provenance' && !(operation.operator === 'ObjectTag' && operand.role === 'ignored-argument')
    )
    .map((operand) => enter(ctx, block, lineage, operation, operand, resolveRequiredOperand(ctx, block, lineage, operand)))
  const representation = requireResultRepresentation(ctx, operation, 'value', `a ${operation.form} computation`)
  registerResult(ctx, operation, ctx.builder.compute(block, lineage, operation.form, operation.operator, operands, representation))
}

const lowerBinding = (ctx: LoweringContext, block: IrBlockId, operation: BindingOperation): void => {
  switch (operation.action) {
    case 'declare':
      // A binding cell coming into existence has no runtime value of its own
      // to materialize; TDZ behavior is carried on the *read* operation
      // instead (`BindingOperation.temporalDeadZone`), not on this event.
      return
    case 'read': {
      const lineage = requireLineage(operation)
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a binding read')
      if (operation.commonJs) {
        registerResult(
          ctx,
          operation,
          ctx.builder.commonJsBinding(block, lineage, operation.commonJs.global, operation.commonJs.owner, representation)
        )
        return
      }
      // A generic function named as a VALUE has no cell to read: nothing
      // instantiated it here, so no copy's callable exists. What the name
      // denotes is which member of the choice it is, and that is a constant
      // -- the index the set's carrier tags it by (`generic-function-set`,
      // representation/model.ts).
      if (representation.kind === 'generic-function-set') {
        const index = representation.members.indexOf(operation.declaration)
        if (index >= 0) {
          registerResult(ctx, operation, ctx.builder.constant(block, lineage, String(index), 'number', representation))
          return
        }
      }
      registerResult(ctx, operation, narrowedBindingRead(ctx, block, lineage, operation, operation.declaration, representation))
      return
    }
    case 'write':
    case 'initialize': {
      const lineage = requireLineage(operation)
      const value = enterRequiredOperand(ctx, block, lineage, operation, singleValueOperand(operation))
      if (operation.commonJs) {
        ctx.builder.commonJsBindingSet(block, lineage, operation.commonJs.global, operation.commonJs.owner, value)
        registerResult(ctx, operation, value.value)
        return
      }
      ctx.builder.bindingWrite(block, lineage, operation.declaration, value)
      // An assignment expression's own value is exactly the value it wrote:
      // reusing that SSA id is exact, not approximate, and avoids a second IR
      // instruction that would just restate a value already in hand.
      registerResult(ctx, operation, value.value)
      return
    }
  }
}

/**
 * Whether a body's result slot holds nothing at all -- a `void` result, or
 * the async/generator wrappers around one (`promise(void)`, an iterator whose
 * completion is `void`) -- so a `return f()` of a void call has nothing to
 * hand back. Mirrors `buildReturnObligations`' own payload selection
 * (`preflight/obligations-graph.ts`).
 */
const returnsNoValue = (abi: CallableAbi | null): boolean => {
  if (!abi) return true
  const result = abi.result
  const payload = result.kind === 'promise' ? result.value : result.kind === 'iterator' ? result.completion : result
  return payload.kind === 'void'
}

const lowerControl = (
  ctx: LoweringContext,
  flow: FlowController,
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  block: IrBlockId,
  operation: ControlOperation
): void => {
  switch (operation.form) {
    case 'debugger':
    case 'branch':
      // `debugger` has no observable effect worth carrying into the IR;
      // `branch` is a pure marker -- its actual control transfer is already
      // built from `ConditionalEdge` membership by the flow controller.
      return
    case 'return': {
      const lineage = requireLineage(operation)
      const returned = operandOf(operation, 'value', 0)
      // `() => f()` where `f` returns `void` returns *nothing*: the call minted
      // no value because `void` is the carrier for "there is none". Unless the
      // enclosing function's own result HOLDS something -- `return
      // sys.exit(code)` in a `number | void` function -- where the language
      // hands the caller `undefined`, the stored form of "no value"
      // (`representation/primitives.ts`'s `storedCarrier`), converted into
      // the result exactly as a written
      // `return undefined` would be.
      const value =
        namesVoidResult(ctx, returned) &&
        (returnsNoValue(ctx.abi) || (returned !== undefined && ctx.constantDeriver.isNeverType(returned.type)))
          ? null
          : resolveOptionalOperand(ctx, block, lineage, returned)
      ctx.builder.return(
        block,
        lineage,
        value !== null && returned !== undefined ? enter(ctx, block, lineage, operation, returned, value) : value
      )
      return
    }
    case 'throw': {
      const lineage = requireLineage(operation)
      const value = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'value'))
      // Into the one carrier a handler catches, never the operand's own. See
      // `thrownValueCarrier` (`lower-exceptions.ts`) for why a native C++
      // `throw` cannot be left carrying the thrown expression's static type:
      // C++ matches a handler BY TYPE, so `throw "boom"` emitting
      // `throw v0;` of a `std::string` simply walked past the
      // `catch (const gea::Value&)` the same source program wrote. That
      // compiled clean and certified clean, and terminated the process.
      const thrown = convertOrDrift(ctx, block, lineage, operation.id, 'value', 0, value, thrownValueCarrier)
      ctx.builder.throw(block, lineage, thrown)
      return
    }
    case 'break':
    case 'continue': {
      const lineage = requireLineage(operation)
      // A transfer out of a loop names the loop, and the loop's own header,
      // latch and exit are the flow controller's to know -- `blockStarts`
      // records where an operation was *lowered*, which for the loop marker
      // is the header, and taking that for a `break` would restart the loop
      // instead of leaving it.
      //
      // `continue` prefers the latch over the header: a `for` loop's own
      // incrementor must run before the condition is re-tested (ECMA-262
      // `ForStatement` evaluation re-enters at the update expression, not the
      // test), and `loopLatchOf` is `null` for exactly the loops that have no
      // incrementor to run first -- a `while`, or a `for` with an empty
      // update clause -- where jumping straight to the header is already
      // correct.
      const loop = completionTargetOf(ctx.graph, operation.id, operation.form)
      // `break` out of a SWITCH is not a jump at all here. A switch lowers as a
      // chain of guards, so leaving a clause is leaving that clause's arm --
      // which is exactly what closing the arm's frame already does, at the join
      // every other arm also reaches. Emitting a jump of our own would either
      // duplicate that one or skip the intermediate joins a variable written in
      // the clause needs its merge in.
      //
      // That is only true for a `break` at the END of its arm. One with
      // statements after it inside the same arm -- `if (x) break; more()` --
      // would have to skip them, and doing nothing runs them instead. The
      // ordering keeps a scope's operations contiguous, so "nothing later
      // shares this scope" is the whole question, and it is refused by name
      // when the answer is no rather than compiled into a fall-through.
      const targeted = loop === null ? null : ctx.graph.operations.get(loop)
      if (targeted?.family === 'boundary' && targeted.boundary === 'label-target') {
        throw new IrLoweringBlockedError(
          'a break to a non-iteration label needs a post-label join block, which this CFG does not yet model'
        )
      }
      if (targeted?.family === 'control' && targeted.form === 'switch') {
        if (operation.form === 'continue') {
          throw new IrLoweringBlockedError('a "continue" cannot name a switch; the graph resolved one to a switch operation')
        }
        // A `break` out of a switch is a jump to the statement's own exit --
        // reserved by this very ask -- because a clause's arm end is no
        // longer where the switch ends: a clause may fall through into the
        // next one, and a statement may follow the break in its own clause.
        ctx.builder.jump(block, lineage, flow.switchExitOf(targeted.id))
        return
      }
      const structural =
        loop === null ? null : operation.form === 'break' ? flow.loopExitOf(loop) : (flow.loopLatchOf(loop) ?? flow.loopHeaderOf(loop))
      const target = structural ?? findCompletionTargetBlock(ctx.graph, blockStarts, operation.id, operation.form)
      ctx.builder.jump(block, lineage, target)
      return
    }
    case 'loop': {
      // A head-tested loop's blocks are the guard's own, plus the back edge the
      // flow controller adds when it closes the taken arm -- so there is nothing
      // left for this operation to lower. A conditionless `for (;;)` has the
      // other loop shape the same controller already owns: opening its loop
      // frame reserves a header, closing it emits an unconditional back edge,
      // and the first `break` lazily reserves its exit. It therefore has no
      // condition operand by construction and likewise places nothing here.
      return
    }
    case 'loop-tail':
      // A tail-tested loop's blocks are entirely the flow controller's:
      // `gating.ts` puts the body in the loop scope and the condition in that
      // loop's latch, and `closeBackEdge` turns the latch's own end into the
      // conditional back edge. Unlike the head-tested case there is nothing to
      // check here -- a missing `condition` operand is not a gap but the
      // `do { ... } while (true)` shape, whose back edge is unconditional.
      return
    case 'await': {
      // No suspension primitive backs this -- see `AwaitOperation`'s own
      // comment (`ir/model.ts`) for why reading the operand's value right now
      // is this backend's honest answer. The paired `async-resume` boundary
      // (`lowerBoundary` below) publishes no value of its own: every consumer
      // of `await x` cites this operation's own result instead
      // (`producers/control.ts`'s `contributeAwait`).
      const lineage = requireLineage(operation)
      const operand = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'operand'))
      const representation = optionalResultRepresentation(ctx, operation, 'value')
      registerResult(ctx, operation, ctx.builder.await(block, lineage, operand, representation))
      return
    }
    case 'try':
      // Every block a try statement needs -- the try body's, the catch
      // handler's, the finally clause's, and the join the non-finally parts
      // rejoin at on ordinary completion -- is built generically by the flow
      // controller from this owner's "region" scope membership, exactly as an
      // `if`'s arms are built from "guard" membership. The try marker itself
      // computes nothing and writes no value.
      //
      // A `finally` clause needs no completion record here and no dispatch
      // after it: `targets/cpp/emit-exceptions.ts` renders it as a SCOPE
      // GUARD's destructor around the whole region, and C++ already runs a
      // destructor on every way out of the scope it guards -- falling off the
      // end, `return`, a `goto` past it (which is what `break`/`continue`
      // lower to), and an exception unwinding. That is exactly ECMAScript's
      // "the finally block runs whatever the completion", so the completions
      // stay ordinary and only the SHAPES C++ cannot express refuse, by name,
      // at emission: a `return`/`break`/`continue` written INSIDE the finally
      // clause, which would leave the guard body rather than the function.
      return
    case 'yield': {
      // A real suspension: the enclosing body is emitted as a C++20 coroutine
      // and this becomes `co_yield`. `yield*` never reaches here --
      // `producers/control.ts` refuses it by name, because delegation is a loop
      // and this position is the middle of an expression.
      const lineage = requireLineage(operation)
      const value = resolveOptionalOperand(ctx, block, lineage, operandOf(operation, 'value', 0))
      const representation = optionalResultRepresentation(ctx, operation, 'value')
      registerResult(ctx, operation, ctx.builder.yield(block, lineage, value, representation))
      return
    }
    case 'switch':
      // A marker, ordered after everything inside the statement. A switch's
      // dispatch IS the chain of guards `gating.ts` builds from the per-clause
      // tests `producers/control.ts` mints, so the flow controller has already
      // built every block and every transfer by the time this is reached; the
      // one thing left is the statement's own exit, which the breaks inside it
      // may have reserved and which control falling out of the last clause
      // must now join.
      flow.closeSwitch(operation.id, null)
      return
    case 'label':
      // A label around an iteration resolves at normalization to that loop's
      // own completion target. The marker itself has no runtime work.
      return
  }
}

/**
 * The run-time half of a modelled `Object.setPrototypeOf(C.prototype,
 * B.prototype)`. The base is read off the heritage value's carrier the same
 * way `projection/classes.ts` reads it, so the class layout and this step
 * name one class: the family's only member, or -- for a slot that also holds
 * subclasses -- its declared class.
 */
const lowerPrototypeReparenting = (ctx: LoweringContext, block: IrBlockId, operation: ClassLifecycleOperation): void => {
  const classOperand = operandOf(operation, 'constructor')
  const heritageOperand = operandOf(operation, 'heritage')
  if (!classOperand || !heritageOperand || heritageOperand.source.kind !== 'result' || classOperand.source.kind !== 'result') {
    throw new IrLoweringBlockedError('a prototype re-parenting names no evaluated class values to link')
  }
  const lineage = heritageOperand.source.result
  const classValue = resolveRequiredOperand(ctx, block, lineage, classOperand)
  const heritage = resolveRequiredOperand(ctx, block, lineage, heritageOperand)
  const carrier = heritage.representation
  const declared = carrier.kind === 'constructor-family' && carrier.abi.result.kind === 'class-ref' ? carrier.abi.result.declaration : null
  const base =
    carrier.kind !== 'constructor-family'
      ? null
      : carrier.members.length === 1
        ? carrier.members[0]!
        : declared !== null && carrier.members.includes(declared)
          ? declared
          : null
  if (base === null) {
    throw new IrLoweringBlockedError(
      `a prototype re-parenting's heritage is carried as ${representationKey(carrier)}, which names no single class to inherit from`
    )
  }
  const classCarrier = classValue.representation
  if (!familyNamesClassCopy(ctx, classCarrier, operation.classDeclaration)) {
    throw new IrLoweringBlockedError(
      `a prototype re-parenting's class value is carried as ${representationKey(classCarrier)}, not ${operation.classDeclaration}'s constructor`
    )
  }
  ctx.builder.reparentConstructor(block, lineage, operation.classDeclaration, base, classValue, heritage)
}

/**
 * Whether a constructor-family names the class a census COPY belongs to.
 *
 * `class-lifecycle` events are minted inside the census's per-copy walk and
 * name the copy (`decl|f0|1@0`), while a class VALUE's carrier names the
 * physical class the copy was published under (`projection/classes.ts`) --
 * the generic root when every copy shares one layout, and the copy's own
 * layout when the generic is instantiated at several. Comparing the two
 * spellings directly refused every static-side lowering of a generic class:
 * a `static count = 0` on `class Box<T>` blocked with "declares receiver
 * ... rather than that class's constructor value" for a class the program
 * instantiates perfectly well.
 */
const familyNamesClassCopy = (ctx: LoweringContext, carrier: Representation | null, copy: DeclarationId): boolean => {
  if (carrier === null || carrier.kind !== 'constructor-family') return false
  if (carrier.members.includes(copy)) return true
  const physical = classLayoutOfCopy(ctx.program.classes, copy)?.declaration
  return physical !== undefined && carrier.members.includes(physical)
}

/**
 * The runtime half of class evaluation that a fixed class layout does not
 * absorb.
 *
 * Methods and instance fields become emitted layout metadata, but a static
 * field initializer is an expression the language evaluates once, in source
 * order, with the class constructor as `this`. Lower it to the same ordinary
 * call and constructor-property store that an authored `Class.key = value`
 * uses. That keeps evaluation order in the enclosing region and lets the
 * static-field storage census see one uniform IR operation for both source
 * spellings.
 */
const lowerClassLifecycle = (ctx: LoweringContext, block: IrBlockId, operation: ClassLifecycleOperation): void => {
  if (operation.event === 'reparent-prototype') {
    lowerPrototypeReparenting(ctx, block, operation)
    return
  }
  if (operation.event !== 'define-field' || operation.placement !== 'static') return
  const initializerOperand = operandOf(operation, 'initializer')
  if (!initializerOperand || initializerOperand.source.kind !== 'result') return
  const lineage = initializerOperand.source.result
  const callee = resolveRequiredOperand(ctx, block, lineage, initializerOperand)
  const abi = abiOfCallee(callee.representation)
  if (!abi) {
    throw new IrLoweringBlockedError(
      `a static field initializer is carried as ${representationKey(callee.representation)}, which declares no callable convention`
    )
  }
  const receiverRepresentation = abi.receiver
  if (!familyNamesClassCopy(ctx, receiverRepresentation, operation.classDeclaration)) {
    throw new IrLoweringBlockedError(
      `a static field initializer for ${operation.classDeclaration} declares receiver ${
        receiverRepresentation ? representationKey(receiverRepresentation) : 'none'
      } rather than that class's constructor value`
    )
  }
  const constructorAllocation = [...ctx.graph.operations.values()].find(
    (entry) =>
      entry.family === 'allocation' &&
      entry.allocated === 'class-constructor-object' &&
      entry.classDeclaration === operation.classDeclaration
  )
  const constructorValue = constructorAllocation ? resultOf(constructorAllocation, 'value') : undefined
  if (!constructorValue || constructorAllocation?.family !== 'allocation') {
    throw new IrLoweringBlockedError(`a static field initializer for ${operation.classDeclaration} has no evaluated constructor object`)
  }
  const receiver = resolveRequiredOperand(ctx, block, lineage, {
    role: 'receiver',
    ordinal: 0,
    evaluation: { kind: 'runtime' },
    source: { kind: 'result', result: constructorValue.id },
    type: constructorAllocation.shape
  })
  const result = ctx.builder.call(block, lineage, callee, receiver, [], abi.result)
  if (result === null) {
    throw new IrLoweringBlockedError(`a static field initializer for ${operation.classDeclaration} produces no value to store`)
  }
  const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
  const stored = enter(ctx, block, lineage, operation, initializerOperand, { value: result, representation: abi.result })
  ctx.builder.set(block, lineage, receiver, key, stored, true, null)
}

const lowerOneOperation = (
  ctx: LoweringContext,
  flow: FlowController,
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  block: IrBlockId,
  operation: SemanticOperation,
  plugins: readonly PluginInstance[]
): void => {
  for (const plugin of plugins) {
    if (plugin.lower(ctx, block, operation)) return
  }
  switch (operation.family) {
    case 'property':
      lowerProperty(ctx, block, operation)
      return
    case 'invocation':
      lowerInvocation(ctx, block, operation)
      return
    case 'computation':
      lowerComputation(ctx, flow, block, operation)
      return
    case 'protocol':
      lowerProtocol(ctx, block, operation)
      return
    case 'binding':
      lowerBinding(ctx, block, operation)
      return
    case 'allocation':
      lowerAllocation(ctx, block, operation)
      return
    case 'control':
      lowerControl(ctx, flow, blockStarts, block, operation)
      return
    case 'boundary':
      lowerBoundary(ctx, block, operation)
      return
    case 'class-lifecycle':
      lowerClassLifecycle(ctx, block, operation)
      return
    case 'element':
      lowerElement(ctx, block, operation, plugins)
      return
    case 'destructuring':
      lowerDestructuring(ctx, flow, block, operation)
      return
    case 'declaration-lifecycle':
      // Linking and initializing a module binding are not runtime steps in a
      // program laid out as one translation unit: an imported name resolves to
      // the very cell the exporting module declares, so there is no second cell
      // to copy into and no indirection to resolve at run time. What these
      // events do carry is *order* -- a module body runs before the bodies that
      // import it -- and order is already carried by the evaluation edges the
      // producer publishes, which the block layout consumes before this point.
      //
      // The `value` result an `initialize` publishes is deliberately left
      // unregistered rather than aliased to something plausible. Nothing that
      // reads an imported name cites it (a read is a `binding` operation naming
      // the same declaration), and if some consumer ever did, resolving its
      // operand would find no SSA id and refuse -- which is the answer we want
      // from a fact this layer cannot supply, instead of a value it invented.
      return
    case 'reference': {
      if (operation.form === 'global-this') {
        const lineage = requireLineage(operation)
        const representation = requireResultRepresentation(ctx, operation, 'value', `a globalThis reference (${operation.id})`)
        const value = ctx.builder.globalThis(block, lineage, representation)
        registerResult(ctx, operation, value)
        return
      }
      // `this` is one reference form that publishes a value, so it is one
      // that lowers: the frame's receiver becomes an SSA value every
      // consumer of `this` then cites like any other result.
      if (operation.form === 'this') {
        const lineage = requireLineage(operation)
        // Ordinarily `receiver`; `captured-receiver` for the one case
        // `semantics/normalize/producers/references.ts`'s `buildThisReference`
        // mints it instead -- a `this` inside an arrow that already-confirmed
        // resolves to an enclosing class's own instance. Both name the same
        // `{kind: 'receiver'}`-sourced operand; only the role differs, and only
        // so `ir/lower-operands.ts`'s `resolveRequiredOperand` can tell a
        // proven capture apart from a receiver this body's own convention
        // simply never declared.
        const operand =
          operandOf(operation, 'receiver', 0) ??
          operandOf(operation, 'captured-receiver', 0) ??
          namedOperand(operation, 'static-class-receiver')
        const resolved = resolveRequiredOperand(ctx, block, lineage, operand)
        registerResult(ctx, operation, resolved.value)
        return
      }
      if (operation.form === 'super-property') {
        // `references.ts`'s `buildSuperReference` reads the same physical
        // frame receiver `this` does, but the checker types bare `super` as
        // the BASE class, so the plan selects a base-class `class-ref` --
        // unlike the derived carrier the receiver slot physically is.
        // Aliasing `this`'s own SSA id (as above) would publish this result
        // under an id whose definition is derived-shaped, and
        // `ir/verify.ts`'s `representationConsistencyGuard` requires every
        // citing operand to match its definition exactly -- a `get`/`call`
        // receiver citing this result states the base carrier, not `this`'s.
        // So a genuinely new SSA definition is minted, at the plan's base
        // representation -- the same `receiver` primitive `this` uses,
        // called again. Emission (`emitReceiver`) declares the C++ local
        // from the frame's ABI receiver slot, not this representation
        // (`defineValue`'s spelling override), so the local is genuinely
        // the derived C++ type and the base carrier is plan-level only --
        // the implicit upcast (`derivesFrom`, `emit-callable.ts`) is free
        // wherever this value is later read into a base-declared slot.
        const lineage = requireLineage(operation)
        const representation = requireResultRepresentation(ctx, operation, 'value', `a super reference (${operation.id})`)
        const value = ctx.builder.receiver(block, lineage, representation)
        registerResult(ctx, operation, value)
        return
      }
      // `parameter-value` is the other reference form that publishes a value:
      // the raw argument a defaulted parameter's own guard tests, before
      // `default-value` (`ir/lower-destructuring.ts`) runs the initializer
      // over it. Resolving its one `{kind: 'parameter'}` operand is exactly
      // what a non-defaulted parameter's own binding read already does; the
      // only difference is that this result exists to be a guard, not a named
      // binding.
      if (operation.form === 'parameter-value') {
        const lineage = requireLineage(operation)
        const resolved = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'argument'))
        registerResult(ctx, operation, resolved.value)
        return
      }
      // A name with no declaration anywhere is the fourth reference form that
      // publishes a value, for the same reason `this` does: there is no cell,
      // so `references.ts`'s `buildReference` publishes the `value` result
      // directly rather than minting a `binding` read nothing could ever
      // satisfy (`hasNoCell`; see that file's own citation-side comment for
      // why this is honest, not a fiction). A citing operand -- an argument, a
      // callee slot -- still needs a real SSA id either way; which id it gets
      // splits on `unresolvableThrows`, the one case ECMA-262 does not make
      // this a throw (13.5.1.2's `typeof` carve-out, `references.ts`'s
      // `isTypeofOperand`) kept apart from the ordinary case by
      // `ReferenceOperation.hasNoCell`'s own comment.
      if (operation.hasNoCell && operation.form === 'identifier') {
        const lineage = requireLineage(operation)
        const representation = requireResultRepresentation(ctx, operation, 'value', `an unresolvable reference (${operation.id})`)
        // `GetValue` (6.2.5.6) throws before a Reference Record's usual
        // read/write pair would even apply -- `emitUnresolvableReference`
        // (`targets/cpp/emit.ts`) is where the citer's SSA id gets a value: a
        // call to a `[[noreturn]]` templated runtime helper, well-typed at
        // whatever carrier the plan selected, that throws the ReferenceError
        // this read really is when the C++ actually reaches it.
        if (operation.unresolvableThrows) {
          const value = ctx.builder.unresolvableReference(block, lineage, representation)
          registerResult(ctx, operation, value)
          return
        }
        // The one case that is NOT a throw: `typeof` on an unresolvable
        // reference returns `"undefined"` (13.5.1.2) without ever calling
        // `GetValue` -- so the citer's SSA id is a plain constant `undefined`,
        // materialized directly at whatever carrier the plan selected for this
        // result. An untyped global's carrier is ordinarily `dynamic`, which
        // is why `targets/cpp/types.ts`'s `cppConstantLiteral` had to gain a
        // `dynamic` case for the `undefined`/`null` literal forms alongside
        // this: a boxed `gea::Value()` for exactly this constant, not
        // something specific to this call site. `three.js`'s `typeof
        // Float16Array !== 'undefined'` is exactly this shape, and is the
        // reason this branch exists at all rather than falling to the refusal
        // below: reaching that refusal here would silently withhold every
        // host-absence feature-detection guard in the corpus, the defect
        // `unresolvable-names.ts`'s own doc comment is about.
        const value = ctx.builder.constant(block, lineage, 'undefined', 'undefined', representation)
        registerResult(ctx, operation, value)
        return
      }
      // Resolving a BOUND name is not an operation the substrate performs: the
      // Reference Record it publishes exists so a read or a write can name the
      // binding, and both carry the declaration themselves. Nothing here can
      // cite the reference as a value -- an operand that tried would find no
      // registered SSA id and be refused, which is the answer we want. (The
      // one exception, an UNBOUND name, is handled above rather than here.)
      return
    }
    default:
      throw new IrLoweringBlockedError(`no IR primitive lowers a semantic operation of family "${operation.family}"`)
  }
}

/**
 * Where a generator's own `FunctionDeclarationInstantiation` work ends --
 * `null` when there is nothing to run early, or when the prologue's own
 * operations do not form a clean prefix of `order` (a hoisted function
 * declaration sharing the entry scope with the formals is the one shape that
 * can do this; `lower-graph.ts`'s `parameterPrologue` only orders the
 * prologue ahead of such a declaration, never ahead of arbitrary later code)
 * -- in which case this owner keeps the single, unsplit coroutine shape it
 * always had rather than risk cutting at a point that is not actually safe.
 *
 * `generatorPrologueBoundary` is a MARKER, not a transform: `ir/generator-
 * split.ts` is what actually carves the body, once `placements` -- which
 * this stage does not have -- is available to give the inner coroutine's own
 * copy of each bridged cell its own identity.
 */
const generatorPrologueBoundaryOf = (
  graph: SemanticGraph,
  order: readonly OperationId[],
  parameterPrologue: ReadonlySet<OperationId>,
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  body: IrBody
): { readonly block: IrBlockId; readonly operationIndex: number; readonly outerBlocks: ReadonlySet<IrBlockId> } | null => {
  // The gate: a plain `parameter` binding with nothing to run early (no
  // default, no destructured pattern) needs no split -- the frame copy a
  // coroutine's own parameters already get before `initial_suspend` runs is
  // every one of those. Only a `destructuring` family operation -- the
  // default's own guarded merge, or a pattern's extraction steps -- means
  // there is real work here (`contributeDefaultedParameter`/`contributeParameter`
  // mint one for a plain defaulted identifier too, so this also gates a bare
  // `v = 5` correctly).
  const hasRealWork = [...parameterPrologue].some((id) => graph.operations.get(id)?.family === 'destructuring')
  if (!hasRealWork) return null

  let lastPrologueIndex = -1
  for (let index = 0; index < order.length; index += 1) if (parameterPrologue.has(order[index] as OperationId)) lastPrologueIndex = index
  if (lastPrologueIndex < 0) return null
  for (let index = 0; index <= lastPrologueIndex; index += 1) {
    if (!parameterPrologue.has(order[index] as OperationId)) return null
  }

  const lastPrologueOperationId = order[lastPrologueIndex] as OperationId
  const cutBlockId = blockStarts.get(lastPrologueOperationId)
  if (cutBlockId === undefined) return null
  const cutBlock = body.blocks.get(cutBlockId)
  if (!cutBlock) return null

  // The block a prologue-marked SEMANTIC operation's own top-level
  // `lowerOneOperation` call started in is only ever the block active when
  // that call BEGAN -- a `default-value`/pattern-extraction operation that
  // desugars to a guard and a merge (`lower-destructuring.ts`) opens its own
  // arm blocks *inside* that one call, and nothing here ever records a
  // `blockStarts` entry for them (`blockStarts` is populated once per
  // semantic operation id in the owner's `order` loop, not once per physical
  // block a single operation's own lowering happens to open). Walking
  // `blockStarts` over `order`'s prefix therefore finds the guard's own block
  // and the merge's, but silently drops the arm blocks the guard branches
  // into -- an `if (has_value) { A } else { B }` split with only `A` or `B`
  // marked outer, corrupting the cut. The forward CFG walk below asks the
  // question `blockStarts` cannot: which physical blocks does execution
  // actually pass through between the function's entry and the cut, and does
  // every operation in each one belong to the prologue -- checked through
  // `operationOfResult(operation.lineage)`, which resolves an IR-only
  // synthesized step (this arm's own representation `convert`, say) back to
  // the semantic operation that caused it to exist, exactly as the
  // `cutBlock` scan below already relies on for its own, narrower question.
  const successorsOf = (terminator: IrBlock['terminator']): readonly IrBlockId[] => {
    switch (terminator.kind) {
      case 'branch':
        return [terminator.whenTrue, terminator.whenFalse]
      case 'jump':
        return [terminator.target]
      case 'switch':
        return [...terminator.cases.map((c) => c.target), terminator.defaultTarget]
      case 'return':
      case 'throw':
        return []
    }
  }
  const outerBlocks = new Set<IrBlockId>()
  const visited = new Set<IrBlockId>()
  const queue: IrBlockId[] = [body.entry]
  let reachedCut = false
  while (queue.length > 0) {
    const id = queue.shift() as IrBlockId
    if (visited.has(id)) continue
    visited.add(id)
    const block = body.blocks.get(id)
    if (!block) return null
    if (id === cutBlockId) {
      // The cut block's own tail -- the operations after `operationIndex`,
      // computed below -- belongs to the inner half; this walk stops here
      // rather than following its terminator, so nothing past the cut is
      // ever asked to justify itself as prologue-owned.
      outerBlocks.add(id)
      reachedCut = true
      continue
    }
    for (const operation of allOperationsOf(block)) {
      if (operation.lineage !== null && !parameterPrologue.has(operationOfResult(operation.lineage))) return null
    }
    outerBlocks.add(id)
    for (const next of successorsOf(block.terminator)) queue.push(next)
  }
  if (!reachedCut) return null

  // The cut inside `cutBlock` itself: everything up to and including the
  // block's own last prologue-owned operation stays outer; the rest -- and
  // the block's terminator -- becomes the inner coroutine's own entry.
  // Scanned from the front so a non-prologue operation interleaved BEFORE the
  // last prologue one -- which should not happen, given the prefix check
  // above, but is not this function's only safeguard against it -- stops the
  // cut at the first such gap rather than past it.
  let operationIndex = 0
  for (const operation of cutBlock.operations) {
    if (!parameterPrologue.has(operationOfResult(operation.lineage))) break
    operationIndex += 1
  }
  return { block: cutBlockId, operationIndex, outerBlocks }
}

interface FiniteIteratorCloseBoundary {
  readonly close: OperationId
  readonly start: OperationId
  readonly entry: IrBlockId
  readonly exit: IrBlockId
}

/** Iterator cleanup regions for complete for-of iterations and finite destructuring sequences. */
const iteratorCloseRegionsOf = (
  graph: SemanticGraph,
  membership: ReturnType<typeof collectConditionalMembership>,
  order: readonly OperationId[],
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  flow: FlowController,
  ctx: LoweringContext,
  blockOrder: readonly IrBlockId[],
  successorsOfBlock: (block: IrBlockId) => readonly IrBlockId[],
  finiteBoundaries: readonly FiniteIteratorCloseBoundary[]
): readonly IrIteratorCloseRegion[] => {
  const regions: IrIteratorCloseRegion[] = []
  const predecessors = new Map<IrBlockId, IrBlockId[]>()
  for (const block of blockOrder) {
    for (const next of successorsOfBlock(block)) {
      const known = predecessors.get(next)
      if (known) known.push(block)
      else predecessors.set(next, [block])
    }
  }
  /**
   * Close a region's membership over the graph.
   *
   * `renderIteratorCloseRegion` emits the region as ONE C++ scope --
   * `entry: { CompletionGuard g{...}; try { <every member block> } catch ... }`
   * -- so the entry label is the only legal way in. A `goto` from outside into
   * any OTHER member is rejected by clang twice over: it bypasses the guard's
   * initialization and it jumps into a try block.
   *
   * The scan above seeds membership from OPERATIONS whose required scope names
   * the loop, and a block that carries no operation of its own is named by
   * none of them. `for (const v of xs) { if (v === 1) break }` lowers its empty
   * `else` arm to exactly such a block: one `goto` to the loop's continue
   * block and nothing else. Its successor was inside the region and it was
   * left outside, which is the illegal edge itself -- so membership is a
   * property of the GRAPH, not of what a block happens to hold.
   *
   * The fixed point pulls every predecessor of a non-entry member in. A
   * predecessor that is not reachable FROM the entry cannot be pulled in
   * without making the region multi-entry, so that refuses by name instead:
   * emitting the region anyway would produce C++ that does not compile, and
   * dropping the member would silently stop closing an iterator.
   */
  const closeRegionOverGraph = (seen: Set<IrBlockId>, entry: IrBlockId, loop: OperationId): void => {
    const reachableFromEntry = new Set<IrBlockId>([entry])
    const queue = [entry]
    while (queue.length > 0) {
      for (const next of successorsOfBlock(queue.pop()!)) {
        if (reachableFromEntry.has(next)) continue
        reachableFromEntry.add(next)
        queue.push(next)
      }
    }
    const pending = [...seen]
    while (pending.length > 0) {
      const member = pending.pop()!
      if (member === entry) continue
      for (const predecessor of predecessors.get(member) ?? []) {
        if (seen.has(predecessor)) continue
        if (!reachableFromEntry.has(predecessor)) {
          throw new IrLoweringBlockedError(
            `iterator-close region ${loop} is entered at ${member} from ${predecessor}, which its continue block ${entry} does not reach; ` +
              'a cleanup region renders as one C++ scope whose guard and try block only the entry may pass'
          )
        }
        seen.add(predecessor)
        pending.push(predecessor)
      }
    }
  }
  for (const loop of order) {
    const operation = graph.operations.get(loop)
    if (!operation) continue
    if (
      operation.family !== 'control' ||
      operation.form !== 'loop' ||
      operation.iteratorClose === null ||
      operation.iteratorClose === undefined
    )
      continue
    const close = graph.operations.get(operation.iteratorClose)
    if (!close || close.family !== 'protocol' || close.step !== 'close') {
      throw new IrLoweringBlockedError(`iterator loop ${loop} names no protocol close operation`)
    }
    const record = operandOf(close, 'iterator-record')
    if (!record || record.source.kind !== 'result') {
      throw new IrLoweringBlockedError(`iterator close ${close.id} has no iterator-record result to preserve`)
    }
    const iterator = resolveResultValue(ctx, record.source.result, `iterator-close region for ${loop}`)
    if (
      iterator.representation.kind !== 'dynamic' &&
      iterator.representation.kind !== 'record' &&
      iterator.representation.kind !== 'native-record-ref' &&
      iterator.representation.kind !== 'iterator'
    ) {
      throw new IrLoweringBlockedError(
        `iterator-close region ${loop} received a ${iterator.representation.kind} carrier; only dynamic, concrete record, or generator iterators can close`
      )
    }
    const guard = membership.guardOfLoop(loop)
    const continueTarget = flow.loopHeaderOf(loop)
    const normalExitTarget = flow.loopNormalExitOf(loop)
    const bodyEntry = flow.loopBodyEntryOf(loop)
    if (guard === null || continueTarget === null || normalExitTarget === null || bodyEntry === null) {
      throw new IrLoweringBlockedError(`iterator loop ${loop} has no head-test body or continuation block`)
    }
    const seen = new Set<IrBlockId>([continueTarget, bodyEntry])
    for (const id of order) {
      const scope = membership.requiredScopeOf(id)
      if (!scope.some((ref) => ref.kind === 'loop' && ref.loop === loop)) continue
      const block = blockStarts.get(id)
      if (block !== undefined) seen.add(block)
    }
    closeRegionOverGraph(seen, continueTarget, loop)
    const blocks = blockOrder.filter((block) => seen.has(block))
    const lineage = resultOf(close, 'completion')?.id
    if (!lineage) throw new IrLoweringBlockedError(`iterator-close ${close.id} published no completion lineage`)
    regions.push({
      loop,
      lineage,
      iterator,
      entry: continueTarget,
      blocks,
      dismissTargets: [continueTarget, normalExitTarget],
      onlyIfOpen: false,
      bodyEntry
    })
  }
  for (const boundary of finiteBoundaries) {
    const close = graph.operations.get(boundary.close)
    if (!close || close.family !== 'destructuring' || close.form !== 'array-pattern-close') continue
    const operand = operandOf(close, 'iterator')
    if (!operand || operand.source.kind !== 'result') {
      throw new IrLoweringBlockedError(`finite iterator close ${close.id} has no iterator result to preserve`)
    }
    const iterator = resolveResultValue(ctx, operand.source.result, `finite iterator-close region ${close.id}`)
    const lineage = resultOf(close, 'completion')?.id
    if (!lineage) throw new IrLoweringBlockedError(`finite iterator close ${close.id} published no completion lineage`)
    const first = blockOrder.indexOf(boundary.entry)
    const last = blockOrder.indexOf(boundary.exit)
    if (first < 0 || last < first) throw new IrLoweringBlockedError(`finite iterator close ${close.id} has an invalid block interval`)
    regions.push({
      loop: close.id,
      lineage,
      iterator,
      entry: boundary.entry,
      blocks: blockOrder.slice(first, last + 1),
      dismissTargets: [],
      onlyIfOpen: true,
      // A finite pattern has no body to separate from its step. Its own
      // step/default split is the same question one level down and is not
      // answered here; see `IrIteratorCloseRegion.bodyEntry`.
      bodyEntry: null
    })
  }
  return regions
}

const lowerOwner = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  constantDeriver: RepresentationDeriver,
  program: LoweringProgram,
  abi: CallableAbi | null,
  construct: CallableAbi | null,
  abiRefusal: string | null,
  owner: OwnerId,
  operationIds: readonly OperationId[],
  plugins: readonly PluginInstance[],
  ownerEdges: readonly SemanticEdge[],
  regionParts: RegionPartMembers,
  deferredIteratorCloses: ReadonlySet<OperationId>,
  /** Whether this owner is a `function*` -- see `generatorPrologueBoundary` below. */
  isGenerator: boolean,
  /** Whether this owner's declaration states `@gea-exact-arms` -- see `LoweringContext.exactArmNarrowing`. */
  exactArmNarrowing: boolean
): IrBody => {
  // Membership first: the execution order below keeps each branch's operations
  // contiguous, which it can only do once every operation's scope chain is
  // known. Nothing in the membership reads a position from the list it is
  // given, so this is a dependency, not a cycle.
  const membership = collectConditionalMembership(graph, operationIds, ownerEdges)
  const { order, parameterPrologue } = orderOwnerOperations(graph, operationIds, membership, ownerEdges, regionParts)
  const builder = createIrBodyBuilder(physicalBodyId(owner, 'default'), owner, abi, construct)
  const ctx: LoweringContext = {
    graph,
    plan,
    constantDeriver,
    program,
    abi,
    abiRefusal,
    builder,
    values: new Map(),
    shortCircuits: new Map(),
    exactArmNarrowing
  }
  const blockStarts = new Map<OperationId, IrBlockId>()
  const finiteCloseStarts = new Map<OperationId, OperationId>()
  const finiteCloseByStart = new Map<OperationId, OperationId>()
  for (const id of order) {
    const close = graph.operations.get(id)
    if (!close || close.family !== 'destructuring' || close.form !== 'array-pattern-close') continue
    const iterator = operandOf(close, 'iterator')
    if (!iterator || iterator.source.kind !== 'result') continue
    const source = operationOfResult(iterator.source.result)
    const first = ownerEdges.find((edge) => edge.kind === 'evaluation' && edge.from === source)?.to
    if (first && first !== close.id) {
      finiteCloseStarts.set(close.id, first)
      finiteCloseByStart.set(first, close.id)
    }
  }
  const finiteEntries = new Map<OperationId, { readonly start: OperationId; readonly entry: IrBlockId }>()
  const finiteBoundaries: FiniteIteratorCloseBoundary[] = []

  const flow = createFlowController({
    builder,
    membership,
    resolveGuardOperand: (guard) => resolveResultValue(ctx, guard, `conditional guard ${guard}`)
  })

  for (const operationId of order) {
    const operation = graph.operations.get(operationId)
    if (!operation) continue
    // IteratorClose is owned by its `for`-`of` completion region. Positioning
    // it in ordinary flow would invoke `.return()` before the loop body.
    if (operation.family === 'protocol' && operation.step === 'close' && deferredIteratorCloses.has(operation.id)) continue
    // A resume boundary that publishes nothing places nothing: `await` and
    // `yield` both fall straight through here (`lowerBoundary`), so resolving a
    // scope for one only risks `enterScope`'s "still terminated" fallback
    // manufacturing a stray block, read downstream as a body that falls off its
    // end -- a bogus `return`.
    //
    // An `exception-region` is the opposite and is excluded by name: it does
    // not sit inside the handler, it OPENS it. It is the only operation a
    // `catch {}` with an empty body owns, so skipping its scope resolution left
    // the catch part never entered, `IrTryRegion.catchEntry` null, and the whole
    // try statement refused at emission -- "no catch clause and no finally
    // primitive to explain the gap", a message describing an internal
    // inconsistency for what is an ordinary ES2019 program (`maps`'s network
    // handler, and `test/fixtures/try-catch-empty.ts`). The ordering hazard that
    // motivated skipping it is gone: `orderOwnerOperations` now schedules a
    // catch part's own opener before every non-prologue member of that part
    // (`lower-graph.ts`), so the scope is entered before anything in the
    // handler can terminate the block.
    if (operation.family === 'boundary' && operation.results.length === 0 && operation.boundary !== 'exception-region') {
      lowerOneOperation(ctx, flow, blockStarts, flow.currentBlock(), operation, plugins)
      continue
    }
    const scope = membership.requiredScopeOf(operationId)
    // `branch`, `switch`, `debugger` and the two LOOP markers compute nothing
    // and place nothing: the transfers they stand for are built by the flow
    // controller out of scope membership, so `lowerControl` returns on sight.
    // They still have to be POSITIONED -- unwinding the frames their scope
    // leaves is what closes the arms of the very construct they mark -- but
    // they must not be given a block of their own once every path has already
    // ended, because that block is an orphan `lower.ts` then terminates with a
    // valueless `return`. See `enterScope`.
    //
    // The loop markers belong here for a reason a head-tested loop never
    // shows: a statement's marker is ordered after everything inside it, so a
    // loop whose body cannot fall out of the bottom reaches its own marker
    // with every path already terminated. `while (true)` inside a `try`, with
    // the only ways out a `return` and a `yield`, is exactly that shape --
    // mongodb's `AbstractCursor[Symbol.asyncIterator]` and
    // `test/fixtures/loop-iteration-helper-repro.ts`. The block opened for the
    // marker there held zero operations and was reached from nothing, and
    // `builder.seal` rejected the whole body: certified clean, 0 lines of C++.
    const placesNothing =
      operation.family === 'control' &&
      (operation.form === 'branch' ||
        operation.form === 'switch' ||
        operation.form === 'debugger' ||
        operation.form === 'loop' ||
        operation.form === 'loop-tail')
    // An optional chain's own value is a merge, and a merge needs both arms
    // closed. That is true exactly once this operation's own guards have
    // unwound, because unwinding is what closes them -- asking any earlier finds
    // the guard still open and blocks. It must also run *before* any guard this
    // operation's own scope newly opens, because a guard whose boolean test is
    // itself a short-circuit result -- `options?.mirror ? a() : b()`, whose
    // ternary guard is the property access's own `short-circuit` result --
    // resolves that test while `enterScope` is still running, not after it
    // returns. Passing the settle step in as a callback `enterScope` runs at
    // exactly that point keeps `lower-flow.ts` ignorant of what a short circuit
    // is, while still settling at the one moment that is safe.
    let block = flow.enterScope(scope, () => settleShortCircuits(ctx, flow, ctx.shortCircuits, scope), placesNothing)
    const finiteCloseAtStart = finiteCloseByStart.get(operationId)
    if (finiteCloseAtStart) {
      const close = graph.operations.get(finiteCloseAtStart)
      const lineage = close ? (resultOf(close, 'completion')?.id ?? null) : null
      block = flow.splitCurrentBlock(lineage)
      finiteEntries.set(finiteCloseAtStart, { start: operationId, entry: block })
    }
    blockStarts.set(operationId, block)
    const finiteStart = finiteCloseStarts.get(operationId)
    if (operation.family === 'destructuring' && operation.form === 'array-pattern-close' && finiteStart) {
      const entry = finiteEntries.get(operation.id)
      if (!entry) throw new IrLoweringBlockedError(`finite iterator close ${operation.id} has no opened cleanup entry`)
      finiteBoundaries.push({ close: operation.id, start: entry.start, entry: entry.entry, exit: block })
      flow.splitCurrentBlock(resultOf(operation, 'completion')?.id ?? null)
      continue
    }
    lowerOneOperation(ctx, flow, blockStarts, block, operation, plugins)
  }

  // Anything still pending is a chain whose value no operation outside its
  // guard ever consumed, so there is nothing to merge into. It is left unbuilt
  // rather than forced: `flow.finish()` is the only thing that can close those
  // arms, and after it there is no block left to put a join in. A read of an
  // unbuilt merge is not silent -- `resolveRequiredOperand` refuses by name.
  const finalState = flow.finish()
  if (!finalState.alreadyTerminated) {
    // A body that runs off its end completes normally -- that is what a module
    // body and a `void` function do, and neither writes a `return` for it. The
    // terminator is synthesized because the CFG needs one, and it cites nothing
    // because nothing in the source authored it; attributing it to whichever
    // operation happened to be last would be the fabrication this refuses.
    builder.return(finalState.block, null, null)
  }

  try {
    const iteratorCloseRegions = iteratorCloseRegionsOf(
      graph,
      membership,
      order,
      blockStarts,
      flow,
      ctx,
      builder.blockOrder(),
      builder.successorsOfBlock,
      finiteBoundaries
    )
    const sealed = builder.seal(
      flow.regionsOpened().map((info) => ({
        region: info.region,
        tryEntry: info.tryEntry,
        catchEntry: info.catchEntry,
        finallyEntry: info.finallyEntry,
        finallyExit: info.finallyExit,
        join: info.join
      })),
      iteratorCloseRegions
    )
    if (!isGenerator) return sealed
    const boundary = generatorPrologueBoundaryOf(graph, order, parameterPrologue, blockStarts, sealed)
    return boundary === null ? sealed : { ...sealed, generatorPrologueBoundary: boundary }
  } catch (error) {
    throw new IrLoweringBlockedError(`IR verification failed for owner ${owner}: ${(error as Error).message}`)
  }
}

/**
 * The plugins' reactive-field statement, merged the identical way
 * `compiler.ts` merges it into `HostSpellings.reactive.fields` (later plugin
 * wins per class, same as every other plugin table there) -- but gated on a
 * plugin also naming a cell to hold one in, empty otherwise. Recomputed here
 * rather than threaded in from `compiler.ts`'s `hosts.reactive.fields`
 * because `lowerToIr` already receives `plugins` and nothing else in
 * `IrLoweringInput` depends on the target's `HostSpellings`; adding that
 * dependency to gain one table would make lowering depend on a target
 * concern for a fact both sides can derive from the same plugins.
 */
const mergedReactiveClassFields = (plugins: readonly PluginInstance[]): ReadonlyMap<DeclarationId, ReadonlySet<string>> => {
  const cell = plugins.reduce<string | null>((claimed, plugin) => plugin.capabilities.nativeReactiveCell ?? claimed, null)
  return cell === null ? new Map() : new Map(plugins.flatMap((plugin) => [...plugin.capabilities.reactiveClassFields]))
}

/**
 * The reverse of `mergedReactiveClassFields`: the FIELD declarations it
 * names, rather than the class declarations it is keyed by -- see
 * `LoweringProgram.reactiveFieldDeclarations`.
 */
const reactiveFieldDeclarationsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactiveFields: ReadonlyMap<DeclarationId, ReadonlySet<string>>
): ReadonlySet<DeclarationId> => {
  const declarations = new Set<DeclarationId>()
  for (const layout of classes.values()) {
    const owned = reactiveFields.get(layout.declaration)
    if (!owned || owned.size === 0) continue
    for (const field of layout.fields) if (owned.has(field.key)) declarations.add(field.declaration)
  }
  return declarations
}

export const lowerToIr = (input: IrLoweringInput): IrLoweringResult => {
  const constantDeriver = input.deriver
  const reactiveFields = mergedReactiveClassFields(input.plugins)
  const program: LoweringProgram = {
    abis: input.abis,
    constructs: input.constructs,
    callableOrigins: input.callableOrigins,
    callableOwnPropertyWrites: input.callableOwnPropertyWrites,
    functionPrototypePropertyWrites: input.functionPrototypePropertyWrites,
    classes: input.classes,
    slots: input.slots,
    conversions: input.conversions,
    drift: [],
    methodValueReceivers: new Map(),
    reactiveFields,
    reactiveFieldDeclarations: reactiveFieldDeclarationsOf(input.classes, reactiveFields)
  }
  const groups = groupOperationsByOwner(input.graph)
  const bodies = new Map<PhysicalBodyId, IrBody>()
  const blocked: IrLoweringBlocker[] = []
  const functionFacts = new Map<FunctionId, { functionSource: string; functionName: string; functionLength: number; generator: boolean }>()
  // Owners whose declaration states `@gea-exact-arms`. Kept apart from
  // `functionFacts`, which is spread onto the emitted body: the tag changes
  // how the body LOWERS and is nothing the body needs to carry afterwards.
  const exactArmOwners = new Set<FunctionId>()
  // The graph is sealed: its loop-owned closes are identical for every body.
  // Collect once instead of scanning the entire program for each function.
  const deferredIteratorCloses = new Set<OperationId>()
  for (const operation of input.graph.operations.values()) {
    if (operation.family === 'control' && operation.form === 'loop' && operation.iteratorClose)
      deferredIteratorCloses.add(operation.iteratorClose)
    if (operation.family === 'allocation' && operation.callable && operation.functionSource !== undefined) {
      functionFacts.set(operation.callable, {
        functionSource: operation.functionSource,
        functionName: operation.functionName ?? '',
        functionLength: operation.functionLength ?? 0,
        generator: operation.generatorFunction === true
      })
      if (operation.exactArms === true) exactArmOwners.add(operation.callable)
    }
  }

  // A function whose body is empty owns no operations, so grouping the graph by
  // owner never mentions it -- and yet it is a real function with a real
  // convention that a `CallableObject` still names the thunk of.
  // `Settings.absorbTouch() {}` is the shape that proved it: two apps emitted a
  // reference to a symbol nothing defined, with no refusal recorded anywhere,
  // because a body that is never built cannot refuse. The projected ABI table
  // is the authority on which functions this program has, so an owner it names
  // and the graph does not is lowered from no operations rather than dropped.
  const owners = new Map<OwnerId, readonly OperationId[]>(groups)
  for (const owner of input.abis.keys()) if (!owners.has(owner)) owners.set(owner, [])

  // The edge table, dealt to the owner that holds each edge's target, once.
  //
  // Both per-owner passes below are filters over the whole table that keep only
  // the edges landing inside the owner (`collectConditionalMembership` tests
  // `members.has(edge.to)`; `orderOwnerOperations` reaches the table only
  // through `addPrecedence`, which refuses any pair with an endpoint outside
  // `members`). Running them against the whole table made lowering cost
  // owners x edges, three scans per body, which is the same shape the capability
  // census carried until it was dealt the same way. The share is dealt in
  // `graph.edges` order, so each pass sees the identical subsequence it selected
  // for itself before, and emits the identical order.
  const ownerOfOperation = new Map<OperationId, OwnerId>()
  for (const [owner, operationIds] of owners) for (const id of operationIds) ownerOfOperation.set(id, owner)
  const edgesByOwner = new Map<OwnerId, SemanticEdge[]>()
  for (const edge of input.graph.edges) {
    const owner = ownerOfOperation.get(edge.to)
    if (owner === undefined) continue
    const bucket = edgesByOwner.get(owner)
    if (bucket) bucket.push(edge)
    else edgesByOwner.set(owner, [edge])
  }
  // Global on purpose -- see `collectRegionParts`. Splitting this one per owner
  // would change which operation each group's opener is, and with it the order
  // the bodies emit.
  const regionParts = collectRegionParts(input.graph)
  const noEdges: readonly SemanticEdge[] = []

  for (const [owner, operationIds] of owners) {
    try {
      // A region is not called, so it has no convention; a function that has one
      // must use the projected one, and a function whose projection was blocked
      // gets `null` -- which its first parameter read then refuses, naming the
      // ABI position it could not resolve rather than inventing a frame.
      const abi = input.abis.get(owner as FunctionId) ?? null
      const construct = input.constructs.get(owner as FunctionId) ?? null
      const abiRefusal = input.abiBlockers.get(owner as FunctionId) ?? null
      const facts = functionFacts.get(owner as FunctionId)
      const body = lowerOwner(
        input.graph,
        input.plan,
        constantDeriver,
        program,
        abi,
        construct,
        abiRefusal,
        owner,
        operationIds,
        input.plugins,
        edgesByOwner.get(owner) ?? noEdges,
        regionParts,
        deferredIteratorCloses,
        facts?.generator === true,
        exactArmOwners.has(owner as FunctionId)
      )
      bodies.set(body.owner, facts === undefined ? body : { ...body, ...facts })
    } catch (error) {
      if (!(error instanceof IrLoweringBlockedError)) throw error
      blocked.push({ owner, reason: error.message })
    }
  }

  return { bodies, blocked: Object.freeze(blocked), slotDrift: Object.freeze(program.drift) }
}
