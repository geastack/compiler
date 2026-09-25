import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { InvocationOperation } from '../semantics/model/operations.js'
import type { Representation } from '../representation/model.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodMutableOf } from '../projection/fields.js'
import type { ConversionNode } from '../conversion/algebra.js'
import { classFamilyOverridesOf } from '../projection/dispatch.js'
import { representationKey } from '../representation/model.js'
import { selectedHostConstructFrameOf } from '../representation/derive.js'
import { fixedDataDefinitionRecipeOf } from './fixed-data-definition.js'
import { objectValueConversionsOf } from './object-value-conversions.js'
import { pendingShortCircuitOf } from './lower-short-circuit.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { lowerProxyConstruct } from './lower-proxy.js'
import { publishObjectAssignFieldConversions } from './call-entry.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import { hostTemplateOfRead } from '../representation/host-templates.js'
import {
  abiOfCallee,
  constructAbiOfCallee,
  packArgumentArray,
  packRestArguments,
  namedOperand,
  type ArgumentSlot,
  optionalResultRepresentation,
  orderedOperandsOf,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveOptionalOperand,
  resolveRequiredOperand,
  enter,
  type LoweringContext,
  convertTo,
  convertOrDrift
} from './lower-operands.js'
import type { CallOperation, IrBlockId, IrOperand } from './model.js'
import {
  operationOfResult,
  withoutFunctionSpecialization,
  type IrValueId,
  type DeclarationId,
  type FunctionId,
  type SemanticResultId
} from '../identity/ids.js'
import { calleeRenderingOf, deferredCalleeOf, numericRestHostCallOf, type DeferredCallee } from '../projection/callee.js'
import { fixedApplyArgumentFieldsOf } from '../projection/apply-arguments.js'
import { callArgumentSlotOf } from '../projection/slots.js'

/** A void call still evaluates to undefined when its optional expression is consumed. */
const registerCallShortCircuit = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: InvocationOperation,
  returned: IrValueId | null,
  representation: Representation | null
): void => {
  const published = resultOf(operation, 'short-circuit')
  if (!published || representation === null) return
  let present: IrOperand
  if (returned !== null) {
    present = { value: returned, representation }
  } else if (representation.kind === 'void') {
    present = {
      value: ctx.builder.constant(block, published.id, 'undefined', 'undefined', { kind: 'undefined' }),
      representation: { kind: 'undefined' }
    }
  } else {
    throw new IrLoweringBlockedError('an optional call published a non-void result without a lowered value')
  }
  const pending = pendingShortCircuitOf(ctx, operation, present)
  if (pending) ctx.shortCircuits.set(pending.result, pending)
}

/** `Function.prototype.bind` with a finite, statically proved prefix becomes one native callable allocation. */
const lowerDeferredFunctionBind = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: InvocationOperation,
  deferred: Pick<DeferredCallee, 'receiver' | 'abi' | 'functionId' | 'unboxedMethod' | 'bindShadowGuard'>
): void => {
  const source = resolveRequiredOperand(ctx, block, lineage, deferred.receiver)
  const result = requireResultRepresentation(ctx, operation, 'value', 'a Function.prototype.bind result')
  if (result.kind !== 'function-value-dispatch') {
    throw new IrLoweringBlockedError('a Function.prototype.bind result has no evaluated function-value dispatch convention')
  }
  const slots = argumentSlotsOf(ctx, block, lineage, operation)
  if (slots.some((slot) => slot.kind === 'spread')) {
    throw new IrLoweringBlockedError('Function.prototype.bind with spread-bound arguments has no finite native prefix to capture')
  }
  const values = slots.map((slot) => slot.value)
  const thisArgument = values.shift() ?? null
  const receiver = deferred.abi.receiver === null ? null : thisArgument
  if (deferred.abi.receiver !== null && receiver === null) {
    throw new IrLoweringBlockedError('Function.prototype.bind omits the this-argument required by the source callable convention')
  }
  if (deferred.abi.restFrom !== null || result.abi.restFrom !== null) {
    throw new IrLoweringBlockedError(
      'Function.prototype.bind between rest-taking native callable conventions is not yet a stated runtime protocol'
    )
  }
  if (values.length > deferred.abi.parameters.length) {
    throw new IrLoweringBlockedError('Function.prototype.bind captures more leading arguments than the source callable convention declares')
  }
  const remaining = deferred.abi.parameters.slice(values.length)
  const exactFrame =
    result.abi.receiver === null &&
    remaining.length === result.abi.parameters.length &&
    representationKey(deferred.abi.result) === representationKey(result.abi.result) &&
    remaining.every((parameter, index) => representationKey(parameter.value) === representationKey(result.abi.parameters[index]!.value))
  if (!exactFrame) {
    throw new IrLoweringBlockedError('Function.prototype.bind result does not state the source callable suffix convention exactly')
  }
  registerResult(
    ctx,
    operation,
    ctx.builder.bindCallable(
      block,
      lineage,
      source,
      deferred.functionId,
      deferred.abi,
      thisArgument,
      receiver,
      values,
      result,
      false,
      deferred.unboxedMethod,
      deferred.bindShadowGuard
    )
  )
}

/**
 * Rewriting `add.call(x, 3, 4)` into `add`'s own call, with `x` as the
 * receiver and `3, 4` packed against `add`'s own convention -- see
 * `deferredFunctionCallCalleeOf`'s comment for why this is a rewrite and not
 * an ordinary call through `.call`'s own declared signature.
 */
const lowerDeferredFunctionCall = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: InvocationOperation,
  deferred: Pick<DeferredCallee, 'receiver' | 'abi' | 'frame' | 'shadowGuard'>
): void => {
  const realCallee = resolveRequiredOperand(ctx, block, lineage, deferred.receiver)
  const evaluated = argumentSlotsOf(ctx, block, lineage, operation)
  const [thisArgSlot, ...tailSlots] = evaluated
  if (!thisArgSlot) {
    throw new IrLoweringBlockedError(
      '"Function.prototype.call" was read with no this-argument to lower; every call needs at least one physical argument'
    )
  }
  if (thisArgSlot.kind === 'spread') {
    throw new IrLoweringBlockedError(
      'a call range-copies a spread argument into "Function.prototype.call"\'s own this-argument position; a spread contributes a ' +
        'runtime number of values and the this-argument is exactly one fixed position'
    )
  }
  // The receiver is a physical argument only when the underlying callable's
  // OWN convention declares one -- an ordinary function that never reads
  // `this` (the TypeScript default for a function with no declared `this`
  // parameter) ignores whatever `.call` passed for it, exactly as the
  // language does: `add.call(x, 3, 4)` calls `add(3, 4)` and `x` is never
  // observed.
  const receiver = deferred.abi.receiver !== null ? thisArgSlot.value : null
  // A BOXED frame is not packed here: `Value::callWithReceiver` takes the flat
  // ECMA-262 argument list and the callee's own thunk fills its rest slot from
  // it. Packing against `deferred.abi` -- the underlying callable's PHYSICAL
  // convention, which this call does not fill -- built the rest array a second
  // time. See `DeferredCallee.frame`.
  const args =
    deferred.frame === 'boxed'
      ? tailSlots.map((slot) => {
          if (slot.kind === 'spread') {
            throw new IrLoweringBlockedError(
              'a call range-copies a spread argument into a boxed "Function.prototype.call" frame; the flat argument list a dynamic ' +
                'call renders has no expansion for a runtime-counted range'
            )
          }
          return slot.value
        })
      : packRestArguments(ctx, block, lineage, operation.id, deferred.abi, tailSlots)
  const representation = optionalResultRepresentation(ctx, operation, 'value')
  const returned = ctx.builder.call(
    block,
    lineage,
    realCallee,
    receiver,
    args,
    representation,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    deferred.shadowGuard
  )
  registerResult(ctx, operation, returned)
  registerCallShortCircuit(ctx, block, operation, returned, representation)
}

/**
 * Rewriting `Math.max.apply(null, [1, 5, 3])` into `Math.max`'s own call,
 * with `null` as the receiver and the array's elements packed against
 * `Math.max`'s own rest convention. A runtime-sized array remains a spread;
 * a closed tuple supplies its stated positions, allowing fixed-arity callees
 * and fixed arguments before a rest tail without inventing a runtime arity.
 *
 * `.apply(thisArg)` -- no second argument -- is the language's own "no
 * arguments" form (`argArray` defaults to an empty list), so a missing
 * second argument packs an empty tail rather than being refused: nothing
 * about the physical argument count here is ambiguous, unlike a truly
 * missing this-argument, which has no such default.
 */
const lowerDeferredFunctionApply = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: InvocationOperation,
  deferred: Pick<DeferredCallee, 'receiver' | 'abi' | 'shadowGuard'>
): void => {
  const realCallee = resolveRequiredOperand(ctx, block, lineage, deferred.receiver)
  const evaluated = argumentSlotsOf(ctx, block, lineage, operation)
  const [thisArgSlot, argsArraySlot, ...overflow] = evaluated
  if (!thisArgSlot) {
    throw new IrLoweringBlockedError(
      '"Function.prototype.apply" was read with no this-argument to lower; every call needs at least one physical argument'
    )
  }
  if (thisArgSlot.kind === 'spread') {
    throw new IrLoweringBlockedError(
      'a call range-copies a spread argument into "Function.prototype.apply"\'s own this-argument position; a spread contributes a ' +
        'runtime number of values and the this-argument is exactly one fixed position'
    )
  }
  if (overflow.length > 0) {
    throw new IrLoweringBlockedError(
      '"Function.prototype.apply" takes exactly a this-argument and one arguments array; this call passes physical arguments beyond ' +
        'those two, which is not a shape the ambient signature declares'
    )
  }
  if (argsArraySlot?.kind === 'spread') {
    throw new IrLoweringBlockedError(
      'a call range-copies a spread argument into "Function.prototype.apply"\'s own arguments-array position; that position is a ' +
        'single array value for the language to spread, not a second spread of its own'
    )
  }
  const receiver = deferred.abi.receiver !== null ? thisArgSlot.value : null
  const argsOperand = operandOf(operation, 'argument', 1)
  const tupleFields =
    argsArraySlot && argsOperand
      ? fixedApplyArgumentFieldsOf(ctx.graph.structuralTypes, argsOperand.type, argsArraySlot.value.representation, ctx.constantDeriver)
      : null
  // The same positional Get/conversion operations used by ordinary arguments
  // reach IR certification. No printer-only unpacking or unchecked ABI cast.
  // Array-backed tuples retain observable runtime length (e.g. after push).
  // Expand only the fixed prefix when a real array rest slot can copy the tail.
  const runtimeTailFrom =
    argsArraySlot?.value.representation.kind === 'array-object' &&
    tupleFields !== null &&
    deferred.abi.restFrom !== null &&
    deferred.abi.parameters[deferred.abi.restFrom]?.value.kind === 'array-object' &&
    tupleFields.length >= deferred.abi.restFrom
      ? deferred.abi.restFrom
      : null
  const tailSlots: readonly ArgumentSlot[] =
    argsArraySlot && tupleFields !== null
      ? [
          ...(runtimeTailFrom === null ? tupleFields : tupleFields.slice(0, runtimeTailFrom)).map((field, index): ArgumentSlot => {
            const keyRepresentation = { kind: 'string' } as const
            const key = {
              value: ctx.builder.constant(block, lineage, field.key, 'string', keyRepresentation),
              representation: keyRepresentation
            }
            const read = {
              value: ctx.builder.get(block, lineage, argsArraySlot.value, key, field.value),
              representation: field.value
            }
            const slot = callArgumentSlotOf(deferred.abi, null, index)
            if (slot.kind === 'slot')
              return {
                kind: 'value',
                value: convertOrDrift(ctx, block, lineage, operation.id, 'apply-argument', index, read, slot.representation)
              }
            if (slot.kind === 'raw') return { kind: 'value', value: read }
            throw new IrLoweringBlockedError(`a fixed apply argument ${index} has no admitted native formal slot`)
          }),
          ...(runtimeTailFrom === null ? [] : [{ kind: 'spread' as const, value: argsArraySlot.value, from: runtimeTailFrom }])
        ]
      : argsArraySlot
        ? [{ kind: 'spread', value: argsArraySlot.value }]
        : []
  const args = packRestArguments(ctx, block, lineage, operation.id, deferred.abi, tailSlots)
  const representation = optionalResultRepresentation(ctx, operation, 'value')
  const returned = ctx.builder.call(
    block,
    lineage,
    realCallee,
    receiver,
    args,
    representation,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    deferred.shadowGuard
  )
  registerResult(ctx, operation, returned)
  registerCallShortCircuit(ctx, block, operation, returned, representation)
}

/**
 * Which host template the printer spells this call from, when it is one this
 * IR states a frame for (`CallOperation.hostTemplate`).
 *
 * The routing is `representation/host-templates.ts`'s `hostTemplateOfRead`,
 * composed of the same predicates the printer routes with: the host protocol
 * `hostMemberReadsOf` looks the member up on, the call-site read it defers,
 * the host member `hostCallText`'s renderers hand to `isArrayText` and
 * `assignText`, and the typed-array receiver and member `prototypeMethodReadsOf`
 * and `typedArrayCallText` defer to `set`'s template. The receiver carrier is the one
 * `lowerProperty` gives that read: the plan's selection, narrowed at the use
 * exactly as `calleeRenderingOf` narrows it. A read this does not recognise --
 * a plugin-bound member, a host-method alias -- records nothing, and its call
 * keeps its convention as its frame.
 */
const hostTemplateOf = (ctx: LoweringContext, operation: InvocationOperation, callee: IrOperand): CallOperation['hostTemplate'] => {
  const input = ctx.program.slots.input
  if (calleeRenderingOf(input, operation) !== 'template') return undefined
  const calleeOperand = operandOf(operation, 'callee')
  if (calleeOperand?.source.kind !== 'result') return undefined
  const producerId = input.graph.results.get(calleeOperand.source.result)
  const producer = producerId === undefined ? undefined : input.graph.operations.get(producerId)
  if (producer?.family !== 'property' || producer.internalMethod !== 'get') return undefined
  if (producer.hostMethod !== undefined || producer.resolvedBinding !== undefined) return undefined
  const key = operandOf(producer, 'key')
  const receiver = operandOf(producer, 'receiver')
  if (key?.source.kind !== 'constant' || receiver === undefined) return undefined
  const held =
    receiver.source.kind === 'result'
      ? (input.plan.selected.get(receiver.source.result) ?? null)
      : receiver.source.kind === 'constant'
        ? input.deriver.derive(receiver.type)
        : null
  if (held === null) return undefined
  const view = narrowedOperandView(held, receiver, input.deriver)
  return hostTemplateOfRead(view, key.source.text, callee.representation) ?? undefined
}

/**
 * The rebuild an `await` of a fresh-array call owes its result: mongodb's
 * `const indexes: IndexDescriptionInfo[] = await this.listIndexes(options).toArray()`,
 * whose cursor is folded onto its `any` copy, so the call settles with `any[]`
 * while the plan publishes the awaited value typed. An `await` reads its
 * operand's payload and nothing more, so the payload is exactly the array the
 * call's body returned -- unshared by the same proof `unsharedArrayRebuildOf`
 * asks at the call -- and it is rebuilt once at the published carrier. Without
 * it the await result named a carrier nothing produced.
 */
export const awaitedUnsharedArrayRebuildOf = (
  ctx: LoweringContext,
  operand: SemanticOperand,
  payload: Representation,
  result: Representation
): { readonly element: ConversionNode } | null => {
  if (payload.kind !== 'array-object' || result.kind !== 'array-object') return null
  if (representationKey(payload) === representationKey(result) || operand.source.kind !== 'result') return null
  const producer = ctx.graph.operations.get(operationOfResult(operand.source.result))
  if (producer?.family !== 'invocation') return null
  const receiver = operandOf(producer, 'receiver', 0)
  const receiverRepresentation = receiver?.source.kind === 'result' ? (ctx.plan.selected.get(receiver.source.result) ?? null) : null
  const rebuild = unsharedArrayRebuildOf(ctx, producer, receiverRepresentation, { kind: 'promise', value: result })
  if (rebuild === null || rebuild.body.kind !== 'promise' || representationKey(rebuild.body.value) !== representationKey(payload))
    return null
  return { element: rebuild.element }
}

/**
 * The rebuild a call's array result needs when the body the call runs
 * returns it at another element carrier -- see
 * `InvocationOperation.unsharedArrayResult` for why a copy is sound only for a
 * result no other reference holds. mongodb's cursor family is folded onto its
 * `any` copy, so `toArray()` runs a body returning `Promise<any[]>` while the
 * read, and the call, carry the view's `Promise<CollectionInfo[]>`.
 *
 * The semantic proof read ONE declaration. The receiver's class must reach
 * exactly one body of it (any copy of that declaration -- the proof is
 * syntactic, so it holds for each), with no override in the family and no
 * prototype write that would substitute another, and the member's layout
 * must install ONE copy under the key, so the call cannot be dispatched to a
 * sibling copy this did not read the result of.
 */
const unsharedArrayRebuildOf = (
  ctx: LoweringContext,
  operation: InvocationOperation,
  receiver: Representation | null,
  representation: Representation | null
): { readonly body: Representation; readonly element: ConversionNode } | null => {
  const fact = operation.unsharedArrayResult
  if (!fact || representation === null || receiver?.kind !== 'class-ref') return null
  const classes = ctx.program.classes
  const owner = receiver.declaration
  const site = classMemberOf(classes, owner, fact.key)
  if (site?.kind !== 'method' || site.method.callable === null) return null
  if (withoutFunctionSpecialization(site.method.callable) !== withoutFunctionSpecialization(fact.functionId)) return null
  if ((classes.get(site.owner)?.methods ?? []).filter((method) => method.key === fact.key).length !== 1) return null
  if (
    classMethodOverrideOf(classes, owner, fact.key) !== null ||
    classFamilyOverridesOf(classes, owner, fact.key).length > 0 ||
    classPrototypeMethodMutableOf(classes, owner, fact.key)
  )
    return null
  const body = site.method.representation === undefined ? null : (abiOfCallee(site.method.representation)?.result ?? null)
  if (body === null || representationKey(body) === representationKey(representation)) return null
  const arrays =
    body.kind === 'promise' && representation.kind === 'promise'
      ? ([body.value, representation.value] as const)
      : ([body, representation] as const)
  const [from, to] = arrays
  if (from.kind !== 'array-object' || to.kind !== 'array-object' || from.ownership !== to.ownership) return null
  if (from.extension !== null || to.extension !== null) return null
  const element = ctx.program.conversions.nodeFor(from.element, to.element)
  return element.capability.kind === 'never' ? null : { body, element }
}

const calleeReceiverIsNativeHandle = (ctx: LoweringContext, operation: InvocationOperation): boolean => {
  if (operation.internalMethod !== 'call') return false
  const receiver = operandOf(operation, 'receiver', 0)
  if (!receiver || receiver.source.kind !== 'result') return false
  return ctx.plan.selected.get(receiver.source.result)?.kind === 'native-handle'
}

/**
 * Whether a call's receiver carries the `iterator` cursor
 * (`representation/model.ts`'s `iterator` kind) this backend builds for
 * `for-of`/spread iteration and for a generator's own resumable body.
 *
 * `next`/`return`/`throw` are that carrier's only callable members
 * (`targets/cpp/prototype/emit-prototype-iterator.ts`'s
 * `iteratorPrototypeMethods`), and every one of them renders through a
 * dedicated dispatch that reads the call's own OPERANDS directly rather than
 * a generated function with a physical calling convention -- the identical
 * fact `calleeReceiverIsNativeHandle` states about a host handle, for the
 * identical reason. `Generator.prototype.next` declares its resume argument
 * as a rest parameter (`...args: [] | [TNext]`, so that the argument is
 * optional), and packing that argument through `packRestArguments` here
 * builds a fresh `array-object` no emitted code ever reads back out of --
 * `emit-prototype-iterator.ts`'s `nextCallText` looks at the call's own
 * argument operand directly, not at an ABI slot past a rest position, so the
 * packed array is a frame built and then silently mismatched against the
 * resume channel's own carrier (`parameter-slot.ts`'s
 * `restParameterUnionOfTuplesElementTypeOf` widens the *declared* slot to a
 * native carrier so the ABI stops boxing it, but the physical call this
 * backend renders for `next` was never the generated, ABI-driven kind that
 * slot belongs to).
 */
const calleeReceiverIsIteratorCarrier = (ctx: LoweringContext, operation: InvocationOperation): boolean => {
  if (operation.internalMethod !== 'call') return false
  const receiver = operandOf(operation, 'receiver', 0)
  if (!receiver || receiver.source.kind !== 'result') return false
  // An async generator's `next(...[value])` is declared the same way, and its
  // calls render through the same operand-reading dispatch.
  const carrier = ctx.plan.selected.get(receiver.source.result)?.kind
  return carrier === 'iterator' || carrier === 'async-generator'
}
/**
 * The call's physical argument slots, in argument-list order.
 *
 * `producers/spread-arguments.ts` publishes an ordinary argument under role
 * `argument` and a rest-tail range copy under role `spread-argument`, both
 * keyed by the position they occupy in the list the callee receives -- one
 * shared counter, so merging the two roles by ordinal recovers exactly the
 * order the call was written in. The same merge-by-ordinal shape
 * `lower-allocation.ts`'s `arrayLiteralSlotsOf` uses for the element/spread
 * split of an array literal, for the same reason: neither role has to know
 * the other exists.
 */
const argumentSlotsOf = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: InvocationOperation
): readonly ArgumentSlot[] => {
  const merged = [
    ...orderedOperandsOf(operation, 'argument').map((operand) => ({ ordinal: operand.ordinal, kind: 'value' as const, operand })),
    ...orderedOperandsOf(operation, 'spread-argument').map((operand) => ({ ordinal: operand.ordinal, kind: 'spread' as const, operand }))
  ].sort((left, right) => left.ordinal - right.ordinal)
  return merged.map((entry) => {
    const resolved = resolveRequiredOperand(ctx, block, lineage, entry.operand)
    const value = entry.kind === 'value' ? enter(ctx, block, lineage, operation, entry.operand, resolved) : resolved
    return entry.operand.from === undefined ? { kind: entry.kind, value } : { kind: entry.kind, value, from: entry.operand.from }
  })
}

export const lowerInvocation = (ctx: LoweringContext, block: IrBlockId, operation: InvocationOperation): void => {
  const lineage = requireLineage(operation)
  if (operation.commonJsRequire) {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a CommonJS module-record require')
    registerResult(
      ctx,
      operation,
      ctx.builder.commonJsRequire(
        block,
        lineage,
        operation.commonJsRequire.owner,
        operation.commonJsRequire.target === null
          ? { absentPackage: operation.commonJsRequire.absentPackage }
          : { module: operation.commonJsRequire.target },
        operation.commonJsRequire.builtinModule,
        representation
      )
    )
    return
  }
  if (operation.deadEventEmission) {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'an event emission no listener observes')
    registerResult(ctx, operation, ctx.builder.constant(block, lineage, 'false', 'boolean', representation))
    return
  }
  if (operation.deadEventRegistration) return
  // `add.call(x, 3, 4)` is sugar for a call to `add` itself, not a call
  // through `.call`'s own declared signature; `.apply` and `.bind` are the
  // same rewrite with their own argument frames (`projection/callee.ts`).
  // Checked before the callee is resolved at all, so the deferred `[[Get]]`
  // this rewrite bypasses is never forced to produce a value nothing
  // downstream reads.
  const deferred = deferredCalleeOf(
    {
      graph: ctx.graph,
      plan: ctx.plan,
      abis: ctx.program.abis,
      constructs: ctx.program.constructs,
      callableOrigins: ctx.program.callableOrigins,
      classes: ctx.program.classes
    },
    operation
  )
  if (deferred?.member === 'call') {
    lowerDeferredFunctionCall(ctx, block, lineage, operation, deferred)
    return
  }
  if (deferred?.member === 'apply') {
    lowerDeferredFunctionApply(ctx, block, lineage, operation, deferred)
    return
  }
  if (deferred?.member === 'bind') {
    lowerDeferredFunctionBind(ctx, block, lineage, operation, deferred)
    return
  }
  const callee = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'callee'))
  const constructed = operation.internalMethod === 'construct' ? optionalResultRepresentation(ctx, operation, 'value') : null
  if (constructed?.kind === 'proxy-object') {
    registerResult(ctx, operation, lowerProxyConstruct(ctx, block, lineage, operation, constructed))
    return
  }
  const evaluated = argumentSlotsOf(ctx, block, lineage, operation)
  // A call through a CHOICE of generic functions: the callee is the set's tag
  // and the `closed-family` target names the copy each member runs at this
  // call. Packed against no convention -- each member's own is padded at
  // emission (`emit-callable.ts`), the same way a callable union's arms are.
  if (callee.representation.kind === 'generic-function-set') {
    if (operation.target.kind !== 'closed-family') {
      throw new IrLoweringBlockedError('a call through a generic function set has no closed family of instantiated copies to dispatch over')
    }
    const family = operation.target.targets.map((target) =>
      target.kind === 'function' && target.member !== undefined ? { member: target.member, functionId: target.functionId } : null
    )
    if (family.some((entry) => entry === null)) {
      throw new IrLoweringBlockedError('a generic function set family names a target that is not an instantiated member copy')
    }
    const args = packRestArguments(ctx, block, lineage, operation.id, null, evaluated)
    const representation = optionalResultRepresentation(ctx, operation, 'value')
    registerResult(
      ctx,
      operation,
      ctx.builder.call(block, lineage, callee, null, args, representation, family as { member: DeclarationId; functionId: FunctionId }[])
    )
    return
  }
  // `super(...)` is the base class's initialization against the receiver this
  // constructor is already building, not an invocation of anything: a class
  // constructor has no `[[Call]]`. Normalize already decided which this is
  // (`resultDivergence`, semantics/model/selected-signature.ts), so reading
  // that here is a citation; recognizing it downstream from the callee's
  // carrier kind instead would be a second authority over the same question.
  if (operation.resultDivergence.kind === 'super-constructor-initialization') {
    // The evaluated arguments still go through `packRestArguments` against the
    // *base's* construct convention, which is what the callee's carrier states,
    // so a base constructor with a rest parameter receives the same frame a
    // `new Base(...)` would build for it.
    const args = packRestArguments(ctx, block, lineage, operation.id, constructAbiOfCallee(callee.representation), evaluated)
    ctx.builder.superInitialize(block, lineage, args)
    return
  }
  // A member reached off a `native-handle` receiver has no physical
  // convention to pack against, even though its own declared signature says
  // otherwise -- see `calleeReceiverIsNativeHandle`'s comment above. Packing
  // here would build an `array-object` for a frame `targets/cpp/host-members.ts`'s
  // call renders through a text template, never a generated function that
  // could ever read it -- exactly the defect that made `Console.log`'s rest
  // argument unstringifiable at emission.
  // ...and only for a member whose rest slot is `dynamic`. That is the
  // text-joined template shape and nothing else: `{args}` renders through
  // `consoleArgumentsText`, which ToStrings each argument, so the member has to
  // accept anything and is declared `...data: any[]`. A rest slot with a
  // CONCRETE element type normally uses the real array-parameter callable ABI.
  // A host may additionally publish a borrowed numeric rest spelling, proved
  // separately below. Merely seeing number[] does not authorize skipping the
  // array: ordinary rest functions and first-class builtin values observe it.
  // A callee that may be absent is invoked through its payload: emission
  // presence-checks it and calls what it holds (`unwrapPresentValue`), so the
  // payload's convention is the frame these arguments fill. Packing against
  // the optional itself states no convention and hands a rest function its
  // loose arguments -- three's `...arguments` shims read off a dynamic key.
  const invoked = callee.representation.kind === 'optional' ? callee.representation.payload : callee.representation
  const calleeAbi = abiOfCallee(invoked)
  const restElement = calleeAbi?.restFrom === null || calleeAbi === null ? null : (calleeAbi.parameters[calleeAbi.restFrom]?.value ?? null)
  const textJoined = restElement?.kind === 'array-object' && restElement.element.kind === 'dynamic'
  // Only numeric operands use the borrowed host frame. Unknown values still
  // enter the ordinary callable convention, and spread iteration stays on the
  // existing materialized path. All argument expressions were evaluated above.
  const numericRestFrame =
    calleeAbi?.restFrom === 0 &&
    restElement?.kind === 'array-object' &&
    restElement.element.kind === 'scalar' &&
    restElement.element.domain === 'number'
  const numericRestCandidate = numericRestFrame ? numericRestHostCallOf(ctx.program.slots.input, operation) : null
  // Rest packing converts each element into the declared numeric slot. Do the
  // same conversion before choosing a borrowed frame: a typed-array read can
  // still carry absence here, even when its call-site use asserts presence.
  // Testing the raw carrier first needlessly materialized a rest Array for
  // every String.fromCharCode(bytes[index]!) in an audio encoding loop.
  // The conversion census decides eligibility before emitting any conversion,
  // so a rejected candidate cannot introduce an unused checked load.
  const numericRestDirect =
    numericRestCandidate !== null &&
    restElement?.kind === 'array-object' &&
    evaluated.every(
      (slot) =>
        slot.kind !== 'spread' &&
        slot.value.representation.kind !== 'dynamic' &&
        ctx.program.conversions.nodeFor(slot.value.representation, restElement.element).capability.kind !== 'never'
    )
      ? numericRestCandidate
      : null
  const numericRestArguments =
    numericRestDirect !== null && restElement?.kind === 'array-object'
      ? evaluated.map((slot) => {
          const converted = convertTo(ctx, block, lineage, slot.value, restElement.element)
          if (converted === null) throw new IrLoweringBlockedError('a borrowed numeric rest argument lost its certified element conversion')
          return converted
        })
      : null
  // `f(...codes)` alone, with `codes` already the numeric array the host's
  // rest frame is: passed whole (see `CallOperation.numericRestHostCall`).
  const numericRestWholeSpread =
    numericRestDirect === null &&
    numericRestFrame &&
    evaluated.length === 1 &&
    evaluated[0]?.kind === 'spread' &&
    evaluated[0].value.representation.kind === 'array-object' &&
    evaluated[0].value.representation.element.kind === 'scalar' &&
    evaluated[0].value.representation.element.domain === 'number'
      ? numericRestHostCallOf(ctx.program.slots.input, operation)
      : null
  const numericRestHostCall =
    numericRestDirect !== null
      ? numericRestDirect
      : numericRestWholeSpread !== null
        ? { ...numericRestWholeSpread, wholeArray: true as const }
        : null
  // `console.log(...values)`, ENTIRELY -- no leading value, nothing after --
  // needs no range copy at all: `values` already IS the runtime-counted
  // sequence the text-joined template's vararg signature declares, so the
  // call can pass it through whole. `emit-host-invoke.ts`'s `variadic` arity
  // reads `argumentsAreSpread` on the built operation to join THIS array's
  // own elements at runtime (`gea_runtime.h`'s
  // `console::joined(const Ref<ArrayObject<Value>>&)`) instead of the
  // compile-time per-operand join every other text-joined call takes. A
  // mixed call (`console.log("x", ...rest)`, three's `utils.js` `log`) has
  // no single array to pass whole, so it builds one: the member's own rest
  // array, every argument in written order with the spread range-copied in,
  // is exactly the sequence the language hands `console.log`.
  // The rest element is `dynamic` (`textJoined`), and a leading formal such
  // a member declares (`log(message?: any, ...optionalParams: any[])`) is
  // joined exactly like the tail, so the one array holds every argument.
  const textRest = restElement
  const wholeSpreadArgument: IrOperand | null =
    textJoined &&
    evaluated.length === 1 &&
    evaluated[0]?.kind === 'spread' &&
    evaluated[0].value.representation.kind === 'array-object' &&
    evaluated[0].value.representation.element.kind === 'dynamic'
      ? evaluated[0].value
      : textJoined &&
          textRest !== null &&
          textRest.kind === 'array-object' &&
          calleeReceiverIsNativeHandle(ctx, operation) &&
          evaluated.some((slot) => slot.kind === 'spread')
        ? { value: packArgumentArray(ctx, block, lineage, evaluated, textRest), representation: textRest }
        : null
  // A callee the program never gave a frame (`Function`, `any`) is called
  // with the flat ECMA-262 argument list, boxed, and the callable it holds
  // binds its own formals from it (`Value::callWithReceiver`). A spread there
  // contributes a runtime number of entries to that list, so the whole list
  // is built as one fresh array -- positional values and range copies in
  // written order, exactly as a rest array is -- and handed over as the
  // argument list itself: `f(a, ...xs)` is `Reflect.apply(f, this, [a, ...xs])`.
  const spreadListCarrier: Extract<Representation, { kind: 'array-object' }> = {
    kind: 'array-object',
    element: callee.representation,
    ownership: 'shared-refcount',
    extension: null
  }
  const dynamicSpreadList: IrOperand | null =
    callee.representation.kind === 'dynamic' && evaluated.some((slot) => slot.kind === 'spread')
      ? { value: packArgumentArray(ctx, block, lineage, evaluated, spreadListCarrier), representation: spreadListCarrier }
      : null
  const args =
    numericRestHostCall !== null
      ? (numericRestArguments ?? evaluated.map((slot) => slot.value))
      : calleeReceiverIsNativeHandle(ctx, operation) && textJoined
        ? wholeSpreadArgument !== null
          ? [wholeSpreadArgument]
          : evaluated.map((slot) => {
              if (slot.kind === 'spread') {
                // The text-joined native-handle path renders its call from the
                // operands themselves, one rendered text per operand, so there is
                // nothing for a range copy to expand INTO -- `console.log(...args)`
                // would print the array where the language prints its elements.
                throw new IrLoweringBlockedError(
                  'a spread argument reaches a host member whose call is rendered from its operands as text; a range copy has no expansion there'
                )
              }
              return slot.value
            })
        : calleeReceiverIsIteratorCarrier(ctx, operation)
          ? evaluated.map((slot) => {
              if (slot.kind === 'spread') {
                throw new IrLoweringBlockedError(
                  "a spread argument reaches a generator cursor's next()/return()/throw(), which reads its own resume/abrupt operand " +
                    'directly and has no rest frame for a range copy to expand into'
                )
              }
              return slot.value
            })
          : packRestArguments(ctx, block, lineage, operation.id, calleeAbi, evaluated)
  // `operation.target` (the `SemanticTargetProof`) is never read here: `open`
  // is a complete answer that selects this same generic path, and a narrower
  // proof does not license skipping straight to a direct call this IR has no
  // separate op for anyway.
  if (operation.internalMethod === 'call') {
    // The semantic graph records the receiver of *every* method-shaped call,
    // because `obj.f()` really does bind `obj` as the this-value -- that is the
    // language, and dropping it there would lose a fact. Whether the receiver
    // is also a *physical* argument is a different question, and the callee's
    // convention is the only authority on it: a signature written in method
    // shape declares a receiver slot, and one written as a function-typed
    // property (an arrow, which closes over `this` instead of binding it)
    // declares none. Passing one anyway to a convention that has no slot for it
    // is what the emitter's own fail-closed check already refuses, so the
    // decision belongs here, once, rather than as a second answer downstream.
    const receiverOperand = operandOf(operation, 'receiver', 0)
    const resolvedReceiver = resolveOptionalOperand(ctx, block, lineage, receiverOperand)
    const supplied =
      resolvedReceiver !== null && receiverOperand !== undefined
        ? enter(ctx, block, lineage, operation, receiverOperand, resolvedReceiver)
        : resolvedReceiver
    const declared = abiOfCallee(callee.representation)?.receiver ?? null
    // ECMA-262 13.3.6.1 EvaluateCall: a callee that is not a property
    // reference is called with `undefined` as its this value. mongodb's
    // `const { initializeClient } = krb; initializeClient(spn, opts)` calls a
    // function whose JS body reads `this` (`this: any`), so its convention
    // states a receiver the bare call fills with exactly that value.
    const unbound =
      receiverOperand === undefined && declared?.kind === 'dynamic'
        ? convertTo(
            ctx,
            block,
            lineage,
            {
              value: ctx.builder.constant(block, lineage, 'undefined', 'undefined', { kind: 'undefined' }),
              representation: { kind: 'undefined' }
            },
            declared
          )
        : null
    const receiver = unbound ?? (declared || callee.representation.kind === 'dynamic' ? supplied : null)
    const representation = optionalResultRepresentation(ctx, operation, 'value')
    // The call yields what the convention returns; the plan may have selected
    // a narrowing of it for the result (`f()` read as `T` where `f` returns
    // `T | undefined` behind a guard). That narrowing is a `convert` the
    // conversion census names, like a binding read's -- see
    // `narrowedBindingRead`. A pair it cannot convert is left to the printer.
    // Only a call through a callable VALUE yields the convention's result: a
    // template the printer spells from the call's operands (`Object.assign`
    // on a native record, a host member) yields whatever the template
    // produces, which is the selected carrier itself.
    const physical = abiOfCallee(callee.representation)?.result ?? null
    const narrows =
      calleeRenderingOf(ctx.program.slots.input, operation) === 'callable' &&
      representation !== null &&
      physical !== null &&
      physical.kind !== 'void' &&
      representationKey(physical) !== representationKey(representation) &&
      ctx.program.conversions.nodeFor(physical, representation).capability.kind !== 'never'
    const rebuild =
      narrows || calleeRenderingOf(ctx.program.slots.input, operation) !== 'callable'
        ? null
        : unsharedArrayRebuildOf(ctx, operation, supplied?.representation ?? null, representation)
    const produced = narrows ? physical : (rebuild?.body ?? representation)
    const definitionKey = operandOf(operation, 'argument', 1)
    const fixedDataDefinition =
      operation.intrinsicMutation === 'object-define-property' &&
      calleeRenderingOf(ctx.program.slots.input, operation) === 'template' &&
      definitionKey?.source.kind === 'constant' &&
      definitionKey.source.literal === 'string' &&
      produced !== null
        ? fixedDataDefinitionRecipeOf(
            args,
            definitionKey.source.text,
            produced,
            ctx.constantDeriver,
            ctx.program.classes,
            ctx.program.conversions,
            operation.intrinsicDataDefinition === true
          )
        : null
    // The host template that prints this call, when this IR states that
    // template's frame; the struct copies it prints are published before the
    // reflection census reads them.
    const hostTemplate = hostTemplateOf(ctx, operation, callee)
    if (hostTemplate === 'object-assign' && wholeSpreadArgument === null)
      publishObjectAssignFieldConversions(args, ctx.constantDeriver, ctx.program.classes, ctx.program.conversions)
    const called = ctx.builder.call(
      block,
      lineage,
      callee,
      receiver,
      args,
      produced,
      undefined,
      operation.builtinModuleLookup,
      wholeSpreadArgument !== null || dynamicSpreadList !== null,
      operation.intrinsicOwnKeys && calleeRenderingOf(ctx.program.slots.input, operation) === 'template' ? true : undefined,
      fixedDataDefinition ?? undefined,
      numericRestHostCall ?? undefined,
      !fixedDataDefinition && wholeSpreadArgument === null && calleeRenderingOf(ctx.program.slots.input, operation) === 'template'
        ? objectValueConversionsOf(operation.intrinsicMutation, args, ctx.constantDeriver, ctx.program.conversions)
        : undefined,
      // Carried whatever the callee's rendering: unlike `intrinsicOwnKeys`,
      // which exists to license a template spelling, this fact says only what
      // the call READS, and that is true of the authenticated intrinsic however
      // it is eventually spelled.
      operation.intrinsicCarrierPredicate,
      calleeRenderingOf(ctx.program.slots.input, operation) === 'template' ? operation.intrinsicReflection : undefined,
      hostTemplate
    )
    const returned =
      narrows && called !== null && physical !== null && representation !== null
        ? (convertTo(ctx, block, lineage, { value: called, representation: physical }, representation)?.value ?? called)
        : rebuild !== null && called !== null && representation !== null
          ? ctx.builder.convert(
              block,
              lineage,
              rebuild.element.id,
              { value: called, representation: rebuild.body },
              representation,
              'unshared-array'
            )
          : called
    registerResult(ctx, operation, returned)
    // `a?.b()` publishes a second value -- what the *expression* evaluates to --
    // which is a merge this arm cannot close, exactly as `a?.b`'s is. It is
    // recorded and settled once an operation outside the guard runs
    // (`lower-short-circuit.ts`).
    registerCallShortCircuit(ctx, block, operation, returned, representation)
    return
  }
  const newTarget = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'new-target'))
  const representation = requireResultRepresentation(ctx, operation, 'value', 'a construct operation')
  // `new WeakMap()` through a host constructor whose overload set joins into
  // no single `[[Construct]]` convention: the overload the checker selected at
  // THIS site is the frame it fills (`selectedHostConstructFrameOf`). A spread
  // argument has no fixed position to lay out, so such a site publishes none.
  const hostFrame =
    callee.representation.kind === 'native-handle' &&
    callee.representation.construct === null &&
    operation.selectedSignature !== null &&
    args.length === evaluated.length &&
    evaluated.every((slot) => slot.kind !== 'spread')
      ? selectedHostConstructFrameOf(ctx.constantDeriver, operation.selectedSignature, args.length, representation)
      : null
  registerResult(
    ctx,
    operation,
    ctx.builder.construct(block, lineage, callee, newTarget, operation.target, args, representation, hostFrame ?? undefined)
  )
}
