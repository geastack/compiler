import type { IrBlockId, IrPhiIncoming } from './model.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import { callableOwnPrototypeAt } from '../semantics/callable-origins.js'
import type { NamespaceKeyedBinding, PropertyOperation } from '../semantics/model/operations.js'
import { resultOf } from '../semantics/model/operands.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { pendingShortCircuitOf } from './lower-short-circuit.js'
import { methodValueOriginOf } from '../projection/callee.js'
import { propertyReadResultRepresentationOf } from '../projection/fields.js'
import { computedPropertyKeyTextsOf, typedComputedReadRecipeOf, typedComputedWriteRecipeOf } from './typed-property-access.js'
import { nativePropertyReadNeedsCoercibility } from './native-property-coercibility.js'
import { holdsProxyArm, lowerProxyAccess, lowerProxyUnionAccess } from './lower-proxy.js'
import type { FlowController } from './lower-flow.js'
import type { IrOperand } from './model.js'
import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import {
  namedOperand,
  optionalResultRepresentation,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveRequiredOperand,
  type LoweringContext,
  convertOrDrift,
  assertedCensusUnionReceiver,
  assertedClassReceiver,
  nativeBaseReceiverView,
  enterRequiredOperand,
  enter,
  narrowedBindingRead,
  reactiveFieldReadOf
} from './lower-operands.js'

/**
 * Lowering the property family: the six object internal methods, and nothing
 * else.
 *
 * Property syntax has exactly one route to the runtime -- `[[Get]]`, `[[Set]]`,
 * `[[Delete]]`, `[[HasProperty]]`, `[[OwnPropertyKeys]]`,
 * `[[DefineOwnProperty]]` (`ir/model.ts`) -- so this file is a dispatch over
 * `internalMethod` with no second, source-shaped path for a property
 * expression to take. It lives apart from `lower.ts` for the same reason
 * `lower-element.ts` and `lower-destructuring.ts` do: one family, one file.
 */
/**
 * The class method body a property read names when it reads a method as a
 * VALUE: a callable carrier stating a receiver, read by a constant key off a
 * class instance (or a class constructor, for a static). What `enter` binds
 * the receiver to when the value reaches a receiver-less slot.
 */
export const lowerProperty = (ctx: LoweringContext, flow: FlowController, block: IrBlockId, operation: PropertyOperation): void => {
  const lineage = requireLineage(operation)
  if (operation.internalMethod === 'set' && operation.resolvedBinding !== undefined) {
    const value = enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value'))
    ctx.builder.bindingWrite(block, lineage, operation.resolvedBinding, value)
    const receiver = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'receiver'))
    const result = requireResultRepresentation(ctx, operation, 'value', 'a resolved binding property write')
    registerResult(ctx, operation, convertOrDrift(ctx, block, lineage, operation.id, 'receiver-result', 0, receiver, result).value)
    return
  }
  if (operation.internalMethod === 'get' && operation.resolvedBinding !== undefined) {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a resolved binding property read')
    const value = narrowedBindingRead(ctx, block, lineage, operation, operation.resolvedBinding, representation)
    registerResult(ctx, operation, value)
    if (operation.shortCircuitAlwaysPresent) {
      const expression = resultOf(operation, 'short-circuit')
      if (expression) ctx.values.set(expression.id, value)
      return
    }
    const pending = pendingShortCircuitOf(ctx, operation, { value, representation })
    if (pending) ctx.shortCircuits.set(pending.result, pending)
    return
  }
  if (operation.internalMethod === 'get' && operation.resolvedBindingsByKey !== undefined) {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a namespace read under a closed key')
    const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
    publishProperty(
      ctx,
      operation,
      namespaceKeyedRead(ctx, flow, block, lineage, operation, operation.resolvedBindingsByKey, key, representation)
    )
    return
  }
  const receiverOperand = namedOperand(operation, 'receiver')
  const incoming = resolveRequiredOperand(ctx, block, lineage, receiverOperand)
  const nativeData = ctx.program.slots.input.nativeCallableData.routeAt(operation.id)
  const view =
    nativeData !== null &&
    (incoming.representation.kind === 'function-value-dispatch' || incoming.representation.kind === 'function-and-constructor')
      ? incoming.representation
      : narrowedOperandView(incoming.representation, receiverOperand, ctx.constantDeriver)
  const viewed =
    nativeBaseReceiverView(ctx, block, lineage, receiverOperand, incoming) ??
    assertedCensusUnionReceiver(ctx, block, lineage, receiverOperand, incoming, ctx.constantDeriver.derive(receiverOperand.type)) ??
    assertedClassReceiver(ctx, block, lineage, receiverOperand, incoming, view) ??
    convertOrDrift(ctx, block, lineage, operation.id, 'receiver', receiverOperand.ordinal, incoming, view, 'receiver-view')
  const method = operation.internalMethod
  if (holdsProxyArm(viewed.representation) && (method === 'get' || method === 'set' || method === 'has-property' || method === 'delete')) {
    const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
    const stored = method === 'set' ? () => enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value')) : null
    const result =
      method === 'get' || method === 'has-property'
        ? requireResultRepresentation(ctx, operation, 'value', `a ${method} on a union holding a Proxy`)
        : optionalResultRepresentation(ctx, operation, 'value')
    const value = lowerProxyUnionAccess(ctx, flow, block, lineage, method, viewed, key, stored, result, operation.strict, (arm, receiver) =>
      lowerPropertyOn(ctx, arm, lineage, operation, receiver)
    )
    publishProperty(ctx, operation, value)
    return
  }
  const receiver = viewed.representation.kind === 'proxy-object' ? proxiedReceiver(ctx, block, lineage, operation, viewed) : viewed
  if (receiver === null) return
  publishProperty(ctx, operation, lowerPropertyOn(ctx, block, lineage, operation, receiver))
}

/**
 * `ns[key]` where the checker closed `key` to a finite set of export names
 * (`PropertyOperation.resolvedBindingsByKey`): a string comparison chain over
 * the run-time key, each arm reading its export's cell exactly as a static
 * `ns.name` does, joined in the read's own carrier. The namespace object has
 * no cell (`projection/bindings.ts` places none), so it is never loaded.
 *
 * The last key is not compared: the checker admits no other key, the same
 * trust every typed parameter's carrier already rests on.
 */
const namespaceKeyedRead = (
  ctx: LoweringContext,
  flow: FlowController,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: PropertyOperation,
  bindings: readonly NamespaceKeyedBinding[],
  key: IrOperand,
  representation: Representation
): IrValueId => {
  const [first, ...rest] = bindings
  if (first === undefined) throw new IrLoweringBlockedError('a namespace read under a closed key names no export')
  if (rest.length === 0) return narrowedBindingRead(ctx, block, lineage, operation, first.declaration, representation)
  const keyIs = (at: IrBlockId, binding: NamespaceKeyedBinding): IrOperand => ({
    value: ctx.builder.compute(
      at,
      lineage,
      'equality',
      '===',
      [key, { value: ctx.builder.constant(at, lineage, binding.key, 'string', { kind: 'string' }), representation: { kind: 'string' } }],
      booleanCarrier
    ),
    representation: booleanCarrier
  })
  const arms = flow.splitOn(lineage, keyIs(block, first))
  const incoming: IrPhiIncoming[] = []
  const readInto = (at: IrBlockId, binding: NamespaceKeyedBinding): void => {
    const value = narrowedBindingRead(ctx, at, lineage, operation, binding.declaration, representation)
    ctx.builder.jump(at, lineage, arms.join)
    incoming.push({ block: at, value: { value, representation } })
  }
  readInto(arms.whenTrue, first)
  let otherwise = arms.whenFalse
  rest.forEach((binding, index) => {
    if (index === rest.length - 1) {
      readInto(otherwise, binding)
      return
    }
    const whenTrue = ctx.builder.openBlock()
    const whenFalse = ctx.builder.openBlock()
    ctx.builder.branch(otherwise, lineage, keyIs(otherwise, binding), whenTrue, whenFalse)
    readInto(whenTrue, binding)
    otherwise = whenFalse
  })
  return ctx.builder.phi(arms.join, lineage, incoming, representation)
}

const booleanCarrier: Representation = { kind: 'scalar', domain: 'boolean' }

/**
 * The operation's value, registered, and -- for a read -- the second value
 * `a?.b` publishes: what the EXPRESSION evaluates to, a merge this arm cannot
 * close, recorded and settled once an operation outside the guard runs
 * (`lower-short-circuit.ts`).
 */
const publishProperty = (ctx: LoweringContext, operation: PropertyOperation, value: IrValueId | null): void => {
  if (value === null) return
  registerResult(ctx, operation, value)
  if (operation.internalMethod !== 'get') return
  if (operation.shortCircuitAlwaysPresent) {
    const expression = resultOf(operation, 'short-circuit')
    if (expression) ctx.values.set(expression.id, value)
    return
  }
  const representation = requireResultRepresentation(ctx, operation, 'value', 'a property get operation')
  const pending = pendingShortCircuitOf(ctx, operation, { value, representation })
  if (pending) ctx.shortCircuits.set(pending.result, pending)
}

/** The internal method itself, on a receiver already in the carrier it is performed on. */
const lowerPropertyOn = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: PropertyOperation,
  receiver: IrOperand
): IrValueId | null => {
  switch (operation.internalMethod) {
    case 'own-property-keys': {
      const representation = requireResultRepresentation(ctx, operation, 'value', 'an own-property-keys operation')
      return ctx.builder.ownPropertyKeys(block, lineage, receiver, representation)
    }
    case 'get': {
      const keyOperand = namedOperand(operation, 'key')
      const key = resolveRequiredOperand(ctx, block, lineage, keyOperand)
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a property get operation')
      if (nativePropertyReadNeedsCoercibility(receiver.representation, representation, operation.methodPresenceTest === true))
        // Preserve the original receiver identity used by call dispatch. This
        // throwing check is an effect at Get, even if the Function value is
        // later deferred or the method-presence result folds to a constant.
        ctx.builder.compute(block, lineage, 'require-object-coercible', 'RequireObjectCoercible', [receiver], receiver.representation)
      // See `PropertyOperation.methodPresenceTest`: the receiver and key are
      // still evaluated above, and the always-present method reads `true`.
      if (operation.methodPresenceTest) return ctx.builder.constant(block, lineage, 'true', 'boolean', representation)
      const reactive =
        keyOperand.source.kind === 'constant'
          ? reactiveFieldReadOf(ctx.program.classes, receiver.representation, keyOperand.source.text, ctx.program.reactiveFields)
          : false
      const held =
        receiver.representation.kind === 'native-handle' && operation.hostReadType !== undefined
          ? ctx.constantDeriver.derive(operation.hostReadType)
          : keyOperand.source.kind === 'constant'
            ? propertyReadResultRepresentationOf(
                ctx.constantDeriver,
                ctx.program.classes,
                ctx.program.abis,
                receiver.representation,
                keyOperand.source.text
              )
            : null
      // The declaration's own `prototype` fact, asked once and carried on the
      // read (`GetOperation.callableOwnPrototype`). The printer cannot ask:
      // the census lives on the semantic graph, and by emission time only the
      // carrier is left -- which is precisely the authority that used to
      // answer this question by accident.
      const callableOwnPrototype =
        keyOperand.source.kind === 'constant' &&
        keyOperand.source.text === 'prototype' &&
        receiver.representation.kind === 'function-value-dispatch'
          ? (callableOwnPrototypeAt(ctx.graph, operation) ?? undefined)
          : undefined
      const typedComputedRead = typedComputedReadRecipeOf(
        ctx.graph,
        operation,
        receiver.representation,
        held ?? representation,
        key.representation,
        ctx.constantDeriver,
        ctx.program.classes,
        ctx.program.conversions
      )
      const raw = ctx.builder.get(
        block,
        lineage,
        receiver,
        key,
        held ?? representation,
        operation.hostMethod,
        reactive,
        callableOwnPrototype,
        operation.normalResult,
        typedComputedRead ?? undefined,
        computedPropertyKeyTextsOf(ctx.graph, operation),
        operation.ordinaryObjectPrototypeKeyAbsent
      )
      const value =
        held === null
          ? raw
          : convertOrDrift(ctx, block, lineage, operation.id, 'read', 0, { value: raw, representation: held }, representation, 'field-read')
              .value
      const method =
        keyOperand.source.kind === 'constant'
          ? methodValueOriginOf(ctx.program.classes, receiver.representation, keyOperand.source.text, representation)
          : null
      if (method !== null) ctx.program.methodValueReceivers.set(value, { receiver, method })
      return value
    }
    case 'has-property': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a has-property operation')
      return ctx.builder.hasProperty(block, lineage, receiver, key, representation)
    }
    case 'delete': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      return ctx.builder.delete(block, lineage, receiver, key, operation.strict, optionalResultRepresentation(ctx, operation, 'value'))
    }
    case 'set': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      // A source-proven rejected Set evaluates the RHS but enters no storage
      // carrier. Its finalized readonly receipt independently authenticates
      // these operands before the printer can omit installation.
      const value =
        operation.nativeCallableReadonlySet === undefined
          ? enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value'))
          : resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'value'))
      return ctx.builder.set(
        block,
        lineage,
        receiver,
        key,
        value,
        operation.strict,
        optionalResultRepresentation(ctx, operation, 'value'),
        typedComputedWriteRecipeOf(ctx.graph, operation, receiver.representation, ctx.constantDeriver, ctx.program.classes) ?? undefined,
        computedPropertyKeyTextsOf(ctx.graph, operation),
        operation.ordinaryFunctionDataWrite,
        operation.ordinaryObjectDataWriteAbsent
      )
    }
    case 'define-own-property': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      const valueOperand = namedOperand(operation, 'value')
      const resolved = resolveRequiredOperand(ctx, block, lineage, valueOperand)
      const value = enter(ctx, block, lineage, operation, valueOperand, resolved)
      // The attributes are the operation's own, never defaults chosen here: a
      // definition with no stated descriptor is an unanswerable question, not
      // a permissive one, and guessing would install a property the source
      // never described.
      const descriptor = operation.descriptor
      if (!descriptor) {
        throw new IrLoweringBlockedError('a define-own-property operation states no descriptor for the IR to install')
      }
      return ctx.builder.defineOwnProperty(
        block,
        lineage,
        receiver,
        key,
        value,
        { writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable },
        optionalResultRepresentation(ctx, operation, 'value'),
        descriptor.writable && descriptor.enumerable && descriptor.configurable
          ? (typedComputedWriteRecipeOf(ctx.graph, operation, receiver.representation, ctx.constantDeriver, ctx.program.classes) ??
              undefined)
          : undefined
      )
    }
  }
}

/**
 * A property operation on a proxy: its trap's call, registered as the
 * operation's result (`null` back), or the target the same operation then
 * runs on when the handler has no such trap. Only the four internal methods
 * a handler literal can trap are lowered; the rest refuse by name.
 */
const proxiedReceiver = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: PropertyOperation,
  proxy: IrOperand
): IrOperand | null => {
  const method = operation.internalMethod
  if (method !== 'get' && method !== 'set' && method !== 'has-property' && method !== 'delete')
    throw new IrLoweringBlockedError(`a "${method}" on a Proxy is not lowered over native carriers; only get, set, has and delete are`)
  const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
  const stored = method === 'set' ? () => enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value')) : null
  const result =
    method === 'get' || method === 'has-property'
      ? requireResultRepresentation(ctx, operation, 'value', `a Proxy ${method}`)
      : optionalResultRepresentation(ctx, operation, 'value')
  const dispatch = lowerProxyAccess(ctx, block, lineage, method, proxy, key, stored, result, operation.strict)
  if (dispatch.kind === 'forward') return dispatch.target
  if (dispatch.value !== null) registerResult(ctx, operation, dispatch.value)
  return null
}
