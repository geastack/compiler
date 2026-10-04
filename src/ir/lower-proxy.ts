import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { representationKey, type Representation } from '../representation/model.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { convertTo, namedOperand, resolveRequiredOperand, type LoweringContext } from './lower-operands.js'
import type { InvocationOperation } from '../semantics/model/operations.js'
import { operandOf } from '../semantics/model/operands.js'
import type { IrBlockId, IrOperand } from './model.js'
import type { FlowController } from './lower-flow.js'

/**
 * Proxy internal methods over native carriers.
 *
 * A `proxy-object` holds its target and its handler, each in its own native
 * carrier (`representation/proxy-carriers.ts` decides which values hold one).
 * ECMA-262 10.5 defines every internal method of a proxy the same way: look
 * the trap up on the handler; if there is none, perform the same internal
 * method on the target; otherwise call the trap with the target, the key and
 * (for `[[Get]]`/`[[Set]]`) the proxy as receiver. The handler is a record
 * whose layout is the literal's own (`structural-layout-type.ts` refuses the
 * lib's `ProxyHandler<T>` as its layout), so which traps exist is a fact of
 * the carrier: a trap field is a call, an absent one is a native operation on
 * the target, and neither needs a lookup at run time.
 *
 * What cannot be answered that way is refused by name and never boxed: a
 * handler whose carrier is not a record states no trap set, an optional trap
 * field would need a presence test this does not yet lower, and a trap whose
 * parameters the protocol's arguments do not convert into (a trap declaring
 * the receiver `any` would need the proxy itself boxed) has no native frame.
 */

type ProxyMethod = 'get' | 'set' | 'has-property' | 'delete'

const trapNames: Readonly<Record<ProxyMethod, string>> = {
  get: 'get',
  set: 'set',
  'has-property': 'has',
  delete: 'deleteProperty'
}

export type ProxyDispatch =
  /** No trap: the same internal method runs on this operand, the proxy's target. */
  | { readonly kind: 'forward'; readonly target: IrOperand }
  /** The trap ran; `value` is the operation's result in the carrier the site asked for, `null` when it asked for none. */
  | { readonly kind: 'trapped'; readonly value: IrValueId | null }

type ProxyCarrier = Extract<Representation, { kind: 'proxy-object' }>

const booleanCarrier: Representation = { kind: 'scalar', domain: 'boolean' }

const trapFieldOf = (handler: Representation, trap: string): Representation | null => {
  if (handler.kind !== 'record')
    throw new IrLoweringBlockedError(
      `a Proxy handler held as "${representationKey(handler)}" states no trap set; only an object-literal handler's traps are known statically`
    )
  const field = handler.fields.find((candidate) => candidate.key === trap)
  if (field === undefined) return null
  if (!field.required)
    throw new IrLoweringBlockedError(
      `the Proxy handler's "${trap}" trap may be absent, and an optional trap has no presence test lowered yet`
    )
  return field.value
}

export const lowerProxyAccess = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  method: ProxyMethod,
  proxy: IrOperand,
  key: IrOperand,
  stored: (() => IrOperand) | null,
  result: Representation | null,
  strict: boolean
): ProxyDispatch => {
  const carrier = proxy.representation as ProxyCarrier
  const trapName = trapNames[method]
  const trapCarrier = trapFieldOf(carrier.handler, trapName)
  const target: IrOperand = {
    value: ctx.builder.proxyPart(block, lineage, proxy, 'target', carrier.target),
    representation: carrier.target
  }
  if (trapCarrier === null) return { kind: 'forward', target }
  const abi = abiOfCallee(trapCarrier)
  if (abi === null || abi.restFrom !== null)
    throw new IrLoweringBlockedError(
      `the Proxy "${trapName}" trap is held as "${representationKey(trapCarrier)}", which states no fixed calling convention`
    )
  const handler: IrOperand = {
    value: ctx.builder.proxyPart(block, lineage, proxy, 'handler', carrier.handler),
    representation: carrier.handler
  }
  const trapKey: IrOperand = {
    value: ctx.builder.constant(block, lineage, trapName, 'string', { kind: 'string' }),
    representation: { kind: 'string' }
  }
  const trap: IrOperand = { value: ctx.builder.get(block, lineage, handler, trapKey, trapCarrier), representation: trapCarrier }
  // The protocol's own argument list (10.5.8 step 8, 10.5.9 step 8, 10.5.7
  // step 7, 10.5.10 step 7). A trap declaring fewer parameters is called with
  // fewer: nothing can observe the arguments it did not declare, since an
  // arrow has no `arguments` and a trap here is a known function.
  const protocol: readonly (readonly [string, IrOperand])[] =
    method === 'get'
      ? [
          ['target', target],
          ['key', key],
          ['receiver', proxy]
        ]
      : method === 'set'
        ? [
            ['target', target],
            ['key', key],
            ['value', stored?.() ?? missing('set', 'value')],
            ['receiver', proxy]
          ]
        : [
            ['target', target],
            ['key', key]
          ]
  if (abi.parameters.length > protocol.length)
    throw new IrLoweringBlockedError(
      `the Proxy "${trapName}" trap declares ${abi.parameters.length} parameters and the protocol passes ${protocol.length}`
    )
  const args = abi.parameters.map((parameter, index) => {
    const [role, operand] = protocol[index] ?? missing(trapName, String(index))
    const converted = convertTo(ctx, block, lineage, operand, parameter.value)
    if (converted === null)
      throw new IrLoweringBlockedError(
        `the Proxy "${trapName}" trap's parameter ${index} takes "${representationKey(parameter.value)}" and the ${role} it is passed is ` +
          `"${representationKey(operand.representation)}", with no native conversion between them`
      )
    return converted
  })
  const thisArgument = abi.receiver === null ? null : convertTo(ctx, block, lineage, handler, abi.receiver)
  if (abi.receiver !== null && thisArgument === null)
    throw new IrLoweringBlockedError(`the Proxy "${trapName}" trap's receiver takes "${representationKey(abi.receiver)}", not the handler`)
  const returns = abi.result.kind === 'void' ? null : abi.result
  const called = ctx.builder.call(block, lineage, trap, thisArgument, args, returns)
  const answer: IrOperand | null = called === null || returns === null ? null : { value: called, representation: returns }
  if (method === 'get') {
    if (result === null) return { kind: 'trapped', value: null }
    return { kind: 'trapped', value: into(ctx, block, lineage, answer ?? missing(trapName, 'result'), result, trapName) }
  }
  // `has`, `set` and `deleteProperty` answer through `ToBoolean` (10.5.7 step
  // 8, 10.5.9 step 8, 10.5.10 step 8).
  const truth: IrOperand = {
    value:
      answer === null
        ? ctx.builder.constant(block, lineage, 'false', 'boolean', booleanCarrier)
        : ctx.builder.test(block, lineage, answer, 'to-boolean'),
    representation: booleanCarrier
  }
  if (method === 'has-property')
    return { kind: 'trapped', value: result === null ? null : into(ctx, block, lineage, truth, result, trapName) }
  if (strict) ctx.builder.proxyTrapCheck(block, lineage, method === 'set' ? 'set' : 'deleteProperty', truth)
  if (result === null) return { kind: 'trapped', value: null }
  // A `[[Set]]` publishes the receiver it wrote into (`producers/properties.ts`); a `delete` its boolean.
  return { kind: 'trapped', value: into(ctx, block, lineage, method === 'set' ? proxy : truth, result, trapName) }
}

const into = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operand: IrOperand,
  result: Representation,
  trapName: string
): IrValueId => {
  const converted = convertTo(ctx, block, lineage, operand, result)
  if (converted === null)
    throw new IrLoweringBlockedError(
      `the Proxy "${trapName}" trap answers "${representationKey(operand.representation)}" and the site reads "${representationKey(result)}", with no native conversion between them`
    )
  return converted.value
}

const missing = (trap: string, what: string): never => {
  throw new IrLoweringBlockedError(`the Proxy "${trap}" dispatch has no ${what} to pass`)
}

/**
 * `new Proxy(target, handler)` (ECMA-262 10.5.14 ProxyCreate): the two
 * arguments stored as they are. The target is the very object every
 * forwarded operation reaches, so it may enter only in its own carrier -- a
 * conversion here would be a copy, and a write through the proxy would land
 * in the copy.
 */
export const lowerProxyConstruct = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: InvocationOperation,
  carrier: ProxyCarrier
): IrValueId => {
  const handlerOperand = operandOf(operation, 'argument', 1)
  if (!handlerOperand) throw new IrLoweringBlockedError('a Proxy construction has no handler argument')
  const target = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'argument'))
  const handler = resolveRequiredOperand(ctx, block, lineage, handlerOperand)
  // A proxy over a proxy: the inner one enters the `dynamic` target slot as its
  // box, which is not a copy -- `gea::boxProxyObject` hands every boxing of one
  // proxy the same box, so the outer proxy forwards to the inner one itself.
  const boxedTarget =
    target.representation.kind === 'proxy-object' && carrier.target.kind === 'dynamic'
      ? convertTo(ctx, block, lineage, target, carrier.target)
      : null
  if (boxedTarget === null && representationKey(target.representation) !== representationKey(carrier.target))
    throw new IrLoweringBlockedError(
      `a Proxy target held as "${representationKey(target.representation)}" would be copied into "${representationKey(carrier.target)}", ` +
        'and a proxy forwards to the object itself, never a copy'
    )
  const stored = convertTo(ctx, block, lineage, handler, carrier.handler)
  if (stored === null)
    throw new IrLoweringBlockedError(
      `a Proxy handler held as "${representationKey(handler.representation)}" does not convert into "${representationKey(carrier.handler)}"`
    )
  return ctx.builder.allocateProxy(block, lineage, boxedTarget ?? target, stored, carrier)
}

/** Whether a carrier is a union one of whose arms is a proxy. */
export const holdsProxyArm = (carrier: Representation): carrier is Extract<Representation, { kind: 'tagged-union' }> =>
  carrier.kind === 'tagged-union' && carrier.arms.some((arm) => arm.value.kind === 'proxy-object')

/**
 * A property operation on a union one arm of which is a proxy: which of the
 * two lowerings runs is the union's run-time arm, so the operation branches on
 * it. The proxy arm runs the trap dispatch above (or, with no trap, the same
 * operation on the target); every other arm is the union without that arm and
 * runs the ordinary operation, exactly as it would have with no proxy in the
 * program. `ordinary` is the caller's own lowering of the operation for a
 * given receiver; the two answers meet in a phi in the site's carrier.
 */
export const lowerProxyUnionAccess = (
  ctx: LoweringContext,
  flow: FlowController,
  block: IrBlockId,
  lineage: SemanticResultId,
  method: ProxyMethod,
  union: IrOperand,
  key: IrOperand,
  stored: (() => IrOperand) | null,
  result: Representation | null,
  strict: boolean,
  ordinary: (block: IrBlockId, receiver: IrOperand) => IrValueId | null
): IrValueId | null => {
  const carrier = union.representation
  if (carrier.kind !== 'tagged-union')
    throw new IrLoweringBlockedError(`a proxy-arm dispatch over "${representationKey(carrier)}", which is not a union`)
  const proxies = carrier.arms.filter((arm) => arm.value.kind === 'proxy-object')
  const rest = carrier.arms.filter((arm) => arm.value.kind !== 'proxy-object')
  const [proxyArm] = proxies
  if (proxies.length !== 1 || !proxyArm || rest.length === 0)
    throw new IrLoweringBlockedError(
      `a union holding ${proxies.length} proxy arms and ${rest.length} others has no one proxy arm to dispatch on`
    )
  const [soleRest] = rest
  const others: Representation = rest.length === 1 && soleRest ? soleRest.value : { kind: 'tagged-union', arms: rest }
  const isProxy = ctx.builder.proxyArmTest(block, lineage, union)
  const arms = flow.splitOn(lineage, { value: isProxy, representation: booleanCarrier })
  const proxy = convertTo(ctx, arms.whenTrue, lineage, union, proxyArm.value)
  // The other arms, under the proof the test just made. Not a `convert`: that
  // is keyed by the carrier PAIR alone, and a pair that drops a proxy arm is
  // refused everywhere else (`targets/cpp/conversions.ts`'s
  // `proxyArmWithoutHome`), because only this branch knows the proxy is dead.
  const live = carrier.arms.flatMap((arm, index) => (arm.value.kind === 'proxy-object' ? [] : [index]))
  const remainder: IrOperand = {
    value: ctx.builder.mergeLiveArmRebuild(arms.whenFalse, lineage, union, others, live, false, ctx.program.conversions),
    representation: others
  }
  if (proxy === null)
    throw new IrLoweringBlockedError(`a union "${representationKey(carrier)}" does not load its proxy arm and its other arms apart`)
  const dispatch = lowerProxyAccess(ctx, arms.whenTrue, lineage, method, proxy, key, stored, result, strict)
  const trapped = dispatch.kind === 'forward' ? ordinary(arms.whenTrue, dispatch.target) : dispatch.value
  ctx.builder.jump(arms.whenTrue, lineage, arms.join)
  const plain = ordinary(arms.whenFalse, remainder)
  ctx.builder.jump(arms.whenFalse, lineage, arms.join)
  if (result === null || trapped === null || plain === null) return null
  return ctx.builder.phi(
    arms.join,
    lineage,
    [
      { block: arms.whenTrue, value: { value: trapped, representation: result } },
      { block: arms.whenFalse, value: { value: plain, representation: result } }
    ],
    result
  )
}
