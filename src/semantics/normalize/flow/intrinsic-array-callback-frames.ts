import ts from 'typescript'
import type { FlowCallSite, ValueFlowIndex } from './model.js'
import type { IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'

export type IntrinsicArrayCallbackMethod =
  | 'forEach'
  | 'map'
  | 'filter'
  | 'some'
  | 'every'
  | 'find'
  | 'findIndex'
  | 'findLast'
  | 'findLastIndex'
  | 'flatMap'
  | 'sort'
  | 'toSorted'
  | 'reduce'
  | 'reduceRight'

export type IntrinsicArrayCallbackRole =
  'element' | 'index' | 'array' | 'sort-left' | 'sort-right' | 'reduce-accumulator' | 'reduce-current'

export type IntrinsicArrayCallbackValueSource =
  | { readonly kind: 'array-elements'; readonly receiver: ts.Expression; readonly excludesSeedElement?: 'first' | 'last' }
  | { readonly kind: 'array-index' }
  | { readonly kind: 'receiver'; readonly receiver: ts.Expression }
  | {
      readonly kind: 'reduce-accumulator'
      readonly receiver: ts.Expression
      readonly initialValue: ts.Expression | null
      readonly seedElement: 'first' | 'last' | null
      /** Later callback invocations can receive the prior callback result. */
      readonly feedback: 'callback-completion'
    }

export interface IntrinsicArrayCallbackArgument {
  /** Runtime callback argument position; callback `this` is described separately. */
  readonly position: number
  readonly role: IntrinsicArrayCallbackRole
  readonly source: IntrinsicArrayCallbackValueSource
}

export interface IntrinsicArrayCallbackFrame {
  readonly call: ts.CallExpression
  readonly method: IntrinsicArrayCallbackMethod
  readonly receiver: ts.Expression
  readonly memberKey: string
  /** The expression occupying the intrinsic callback operand. The graph resolves its callable values. */
  readonly callback: ts.Expression
  readonly callbackOperandPosition: number
  readonly arguments: readonly IntrinsicArrayCallbackArgument[]
  readonly initialValue: ts.Expression | null
  readonly thisBinding: {
    readonly kind: 'callback-thisArg'
    /** null means the intrinsic supplies undefined; target strictness governs JS this conversion. */
    readonly value: ts.Expression | null
    /** Arrow callback targets ignore thisArg and retain their lexical receiver. */
    readonly arrowsUseLexicalThis: true
  }
  /** The graph must prove a runtime Array root and no own receiver slot shadowing. */
  readonly receiverObligations: {
    readonly arrayBrand: true
    readonly unshadowedMember: true
    readonly memberKey: string
  }
  /** Must be included by the graph's final seal; this helper does not discharge it. */
  readonly protocolRequirements: readonly IntrinsicProtocolRequirement[]
  /** Whether the method declaration itself was authenticated by checker identity. */
  readonly identity: 'standard-array-member' | 'runtime-array-lookup'
}

export type IntrinsicArrayCallbackFrameResult =
  | { readonly kind: 'not-intrinsic' }
  | { readonly kind: 'unresolved'; readonly reason: string }
  | {
      readonly kind: 'no-callback'
      readonly call: ts.CallExpression
      readonly method: 'sort' | 'toSorted'
      readonly receiver: ts.Expression
      readonly memberKey: string
      readonly receiverObligations: IntrinsicArrayCallbackFrame['receiverObligations']
      readonly protocolRequirements: readonly IntrinsicProtocolRequirement[]
      readonly identity: IntrinsicArrayCallbackFrame['identity']
    }
  | { readonly kind: 'frame'; readonly frame: IntrinsicArrayCallbackFrame }

type MethodShape = {
  readonly method: IntrinsicArrayCallbackMethod
  readonly optionalCallback: boolean
  readonly thisArgumentPosition: number | null
  readonly callbackRoles: readonly IntrinsicArrayCallbackRole[]
}

const callbackShape = (
  method: IntrinsicArrayCallbackMethod,
  optionalCallback: boolean,
  thisArgumentPosition: number | null,
  callbackRoles: readonly IntrinsicArrayCallbackRole[]
): MethodShape => ({ method, optionalCallback, thisArgumentPosition, callbackRoles })

const methodShapes: ReadonlyMap<string, MethodShape> = new Map<string, MethodShape>([
  ...(['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap'] as const).map(
    (method): readonly [string, MethodShape] => [method, callbackShape(method, false, 1, ['element', 'index', 'array'])]
  ),
  ...(['sort', 'toSorted'] as const).map((method): readonly [string, MethodShape] => [
    method,
    callbackShape(method, true, null, ['sort-left', 'sort-right'])
  ]),
  ...(['reduce', 'reduceRight'] as const).map((method): readonly [string, MethodShape] => [
    method,
    callbackShape(method, false, null, ['reduce-accumulator', 'reduce-current', 'index', 'array'])
  ])
])

const literalMemberKey = (callee: ts.Expression): string | null => {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (!ts.isElementAccessExpression(callee) || !callee.argumentExpression) return null
  const key = callee.argumentExpression
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null
}

const unionParts = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types.flatMap(unionParts) : [type])

const standardArrayMember = (checker: ts.TypeChecker, anchor: ts.Node, declaration: ts.Declaration): boolean => {
  const owner = declaration.parent
  return (
    ts.isInterfaceDeclaration(owner) &&
    (owner.name.text === 'Array' || owner.name.text === 'ReadonlyArray') &&
    declaration.getSourceFile().hasNoDefaultLib &&
    checker.getSymbolAtLocation(owner.name) === checker.resolveName(owner.name.text, anchor, ts.SymbolFlags.Interface, false)
  )
}

const isUndefinedValue = (checker: ts.TypeChecker, flow: ValueFlowIndex, expression: ts.Expression): boolean => {
  const value = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (ts.isVoidExpression(value)) return true
  if (!ts.isIdentifier(value) || value.text !== 'undefined' || flow.targetOf(value)?.declaration) return false
  const symbol = checker.getSymbolAtLocation(value)
  const declarations = symbol?.declarations ?? []
  const globalUndefined = checker.resolveName('undefined', value, ts.SymbolFlags.Value, false)
  return (
    symbol !== undefined &&
    symbol === globalUndefined &&
    (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0 &&
    (declarations.length === 0 || declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib))
  )
}

const sourceForRole = (
  role: IntrinsicArrayCallbackRole,
  receiver: ts.Expression,
  initialValue: ts.Expression | null,
  method: IntrinsicArrayCallbackMethod
): IntrinsicArrayCallbackValueSource => {
  switch (role) {
    case 'element':
    case 'sort-left':
    case 'sort-right':
    case 'reduce-current':
      return {
        kind: 'array-elements',
        receiver,
        ...(method === 'reduce' && initialValue === null ? { excludesSeedElement: 'first' as const } : {}),
        ...(method === 'reduceRight' && initialValue === null ? { excludesSeedElement: 'last' as const } : {})
      }
    case 'index':
      return { kind: 'array-index' }
    case 'array':
      return { kind: 'receiver', receiver }
    case 'reduce-accumulator':
      return {
        kind: 'reduce-accumulator',
        receiver,
        initialValue,
        seedElement: initialValue === null ? (method === 'reduce' ? 'first' : 'last') : null,
        feedback: 'callback-completion'
      }
  }
}

/**
 * Describe callback frames for authenticated Array/ReadonlyArray methods.
 * This is an inventory leaf: it never resolves callback values, array
 * contents, aliases, receiver closure, or callable completion. The caller
 * must discharge the receiver and intrinsic-prototype obligations in its
 * shared proof graph. A method name alone never authenticates a source
 * lookalike; when checker attribution is absent on an `any` receiver, the
 * result is explicitly only a runtime-array candidate.
 */
export const intrinsicArrayCallbackFrameOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  site: FlowCallSite
): IntrinsicArrayCallbackFrameResult => {
  if (!ts.isCallExpression(site.call) || site.operands.kind !== 'call' || site.operands.explicitThis) return { kind: 'not-intrinsic' }
  const callee = site.operands.callee
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return { kind: 'not-intrinsic' }
  const memberKey = literalMemberKey(callee)
  if (memberKey === null) return { kind: 'not-intrinsic' }
  const shape = methodShapes.get(memberKey)
  if (!shape) return { kind: 'not-intrinsic' }
  if (site.operands.dispatch.kind !== 'member' || site.operands.receiver === null)
    return { kind: 'unresolved', reason: 'not-a-normal-member-call' }
  if (site.operands.receiver !== callee.expression) return { kind: 'unresolved', reason: 'receiver-does-not-match-member-lookup' }

  const receiver = site.operands.receiver
  const receiverType = checker.getTypeAtLocation(receiver)
  const parts = unionParts(receiverType)
  const anyReceiver = parts.some((part) => (part.flags & ts.TypeFlags.Any) !== 0)
  const member = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression!)
  let identity: IntrinsicArrayCallbackFrame['identity']
  if (member?.declarations?.length) {
    if (!member.declarations.some((declaration) => standardArrayMember(checker, receiver, declaration))) return { kind: 'not-intrinsic' }
    identity = 'standard-array-member'
  } else if (anyReceiver) identity = 'runtime-array-lookup'
  else return { kind: 'unresolved', reason: 'array-member-identity-unavailable' }

  // The frame relies on the intrinsic method running with the intrinsic
  // semantics, and what that reads off `Array.prototype` is finite: the method
  // itself, every index (a hole read falls through to the prototype) and, for
  // the species-creating methods (`map`/`filter`/`flatMap`/`toSorted`),
  // `constructor` and `@@species`; `length` and the present elements are own.
  // Demanding the whole prototype instead fails under ANY unattributed
  // prototype-key write -- on hono-hello that was the one obligation the sealed
  // census could not discharge (reg-exp-router `[middleware, routes].forEach`)
  // while none of the keys the call reads was ever written. An `any` receiver
  // proves nothing about the receiver's own shape, so the runtime lookup keeps
  // the whole-prototype obligation.
  const protocolRequirements: readonly IntrinsicProtocolRequirement[] = [
    identity === 'standard-array-member'
      ? { intrinsic: 'Array', prototypeKeys: { names: [memberKey, 'constructor', '@@species'], arrayIndices: true }, location: site.call }
      : { intrinsic: 'Array', location: site.call }
  ]
  const receiverObligations = { arrayBrand: true as const, unshadowedMember: true as const, memberKey }
  const args = site.operands.args
  if (args.some(ts.isSpreadElement)) return { kind: 'unresolved', reason: 'spread-arguments' }
  const callback = args[0]
  if (!callback) {
    if (!shape.optionalCallback) return { kind: 'unresolved', reason: 'missing-required-callback' }
    return {
      kind: 'no-callback',
      call: site.call,
      method: shape.method as 'sort' | 'toSorted',
      receiver,
      memberKey,
      receiverObligations,
      protocolRequirements,
      identity
    }
  }
  if (shape.optionalCallback && isUndefinedValue(checker, flow, callback))
    return {
      kind: 'no-callback',
      call: site.call,
      method: shape.method as 'sort' | 'toSorted',
      receiver,
      memberKey,
      receiverObligations,
      protocolRequirements,
      identity
    }

  const initialValue = shape.method === 'reduce' || shape.method === 'reduceRight' ? (args[1] ?? null) : null
  const thisArgument = shape.thisArgumentPosition === null ? null : (args[shape.thisArgumentPosition] ?? null)
  const arguments_ = shape.callbackRoles.map((role, position) => ({
    position,
    role,
    source: sourceForRole(role, receiver, initialValue, shape.method)
  }))
  return {
    kind: 'frame',
    frame: {
      call: site.call,
      method: shape.method,
      receiver,
      memberKey,
      callback,
      callbackOperandPosition: 0,
      arguments: arguments_,
      initialValue,
      thisBinding: { kind: 'callback-thisArg', value: thisArgument, arrowsUseLexicalThis: true },
      receiverObligations,
      protocolRequirements,
      identity
    }
  }
}
