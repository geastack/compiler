import ts from 'typescript'
import type { FlowInvocationOperands, ReceiverReference, ValueFlowIndex } from './model.js'
import type { IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { callableCompletionSummaryOf, callableCompletionValuesOf, type CallableCompletionSummary } from './callable-completions.js'
import { isTypePositionReference } from './targets.js'
import { sourceInvocationFrameLayoutOf, type SourceInvocationFrameLayout } from './source-invocation-frame-layout.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { argumentsObjectUsesAt } from '../arguments-objects.js'

const invocationFactIdentity: unique symbol = Symbol('source-invocation-fact')

export interface InvocationValueUses {
  readonly value: ts.Expression
  readonly parameter: ts.ParameterDeclaration | null
  /** Only actual arguments inhabit the arguments object. */
  readonly argumentPosition: number | null
  readonly restElementPosition: number | null
  /** Defaults conservatively continue only along the undefined-argument branch. */
  readonly activation: 'always' | 'argument-undefined'
  readonly uses: readonly ts.Expression[]
  /** Uses of an actual argument after it is packed into an identifier rest array. */
  readonly elementUses: readonly ts.Expression[]
}

export interface SourceInvocationFrame {
  readonly layout: SourceInvocationFrameLayout
  readonly body: ts.SignatureDeclaration
  readonly parameters: readonly ts.ParameterDeclaration[]
  readonly receiverUses: readonly ReceiverReference[]
  /** Known body outcomes survive an unresolved exact-result projection. */
  readonly completionSummary: CallableCompletionSummary
  /** Complete continuation into this body, or a named unsupported frame. */
  readonly forwarding:
    | { readonly kind: 'values'; readonly entries: readonly InvocationValueUses[] }
    | {
        readonly kind: 'unresolved'
        readonly reason: 'spread-arguments' | 'destructured-parameter' | 'arguments-object'
      }
  /** Source normal completions in this call's receiver frame. */
  readonly completions:
    | { readonly kind: 'values'; readonly values: readonly ts.Expression[] }
    | { readonly kind: 'unresolved'; readonly reason: 'optional-call' | 'deferred-or-unnamed-completion' | 'implicit-receiver' }
}

/** The admitted target set and operand mapping belong to the same proof. */
export interface SourceInvocationFact {
  readonly [invocationFactIdentity]: true
  readonly call: ts.CallExpression
  readonly operands: FlowInvocationOperands
  readonly frames: readonly SourceInvocationFrame[]
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

/** Only the invocation authority may publish an admitted frame family. */
export const sourceInvocationFact = (
  call: ts.CallExpression,
  operands: FlowInvocationOperands,
  frames: readonly SourceInvocationFrame[],
  requirements: readonly IntrinsicProtocolRequirement[]
): SourceInvocationFact => ({ [invocationFactIdentity]: true, call, operands, frames, requirements })

/** The frame access is written, deleted, or appears in a destructuring target. */
const frameWrite = (access: ts.Expression): boolean => {
  let target: ts.Expression = access
  let context = target.parent
  while (ts.isParenthesizedExpression(context) && context.expression === target) {
    target = context
    context = context.parent
  }
  if (
    ts.isBinaryExpression(context) &&
    context.left === target &&
    context.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    context.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true
  if (
    (ts.isPrefixUnaryExpression(context) || ts.isPostfixUnaryExpression(context)) &&
    (context.operator === ts.SyntaxKind.PlusPlusToken || context.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return true
  return (
    ts.isDeleteExpression(context) ||
    ts.isArrayLiteralExpression(context) ||
    ts.isPropertyAssignment(context) ||
    ts.isShorthandPropertyAssignment(context) ||
    ts.isSpreadElement(context)
  )
}

/**
 * Every read of a callable's own arguments object that can yield an argument.
 * A null result means the object is used in a way whose carried values cannot
 * be represented by a finite invocation frame.
 */
const argumentsElementReadsOf = (
  body: ts.SignatureDeclaration,
  argumentsUsesAt: (body: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined
): readonly ts.Expression[] | null => {
  const reads: ts.Expression[] = []
  for (const identifier of argumentsUsesAt(body) ?? []) {
    const access = identifier.parent
    if (ts.isPropertyAccessExpression(access) && access.expression === identifier && access.name.text === 'length' && !frameWrite(access))
      continue
    if (ts.isElementAccessExpression(access) && access.expression === identifier && !frameWrite(access)) {
      reads.push(access)
      continue
    }
    return null
  }
  return reads
}

/**
 * Constructed only by the invocation authority after target admission. Keeping
 * the frame builder separate from admission lets recursive target proofs follow
 * a known body's continuations without pretending the whole invocation closed.
 */
export const sourceInvocationFrame = (
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  body: ts.SignatureDeclaration,
  argumentsUsesAt: (body: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined
): SourceInvocationFrame | null => {
  const layout = sourceInvocationFrameLayoutOf(flow, call, body)
  const completionSummary = callableCompletionSummaryOf(flow, body)
  if (layout === null || completionSummary === null) return null
  const { parameters, receiverUses, operands } = layout
  const entries: InvocationValueUses[] = []
  const parameterUses = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] =>
    flow.referencesToDeclaration(parameter).filter((reference) => reference !== parameter.name && !isTypePositionReference(reference))
  const frameReads = argumentsElementReadsOf(body, argumentsUsesAt)
  const restPosition = parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined)
  const restParameter = restPosition < 0 ? undefined : parameters[restPosition]
  const restUses = restParameter && ts.isIdentifier(restParameter.name) ? parameterUses(restParameter) : []
  for (let position = 0; position < operands.args.length; position++) {
    const value = operands.args[position]!
    const parameter = restPosition >= 0 && position >= restPosition ? restParameter : parameters[position]
    const uses = new Set<ts.Expression>(frameReads ?? [])
    const elementUses = new Set<ts.Expression>()
    if (restPosition >= 0 && position >= restPosition) {
      for (const use of restUses) elementUses.add(use)
    } else if (parameter && ts.isIdentifier(parameter.name)) {
      for (const use of parameterUses(parameter)) uses.add(use)
    }
    entries.push({
      value,
      parameter: parameter ?? null,
      argumentPosition: position,
      restElementPosition: restPosition >= 0 && position >= restPosition ? position - restPosition : null,
      activation: 'always',
      uses: [...uses],
      elementUses: [...elementUses]
    })
  }
  if (layout.arguments.kind === 'positional')
    for (const slot of layout.arguments.slots)
      if (slot.kind === 'single' && slot.defaultValue && slot.defaultActivation !== 'never' && ts.isIdentifier(slot.parameter.name))
        entries.push({
          value: slot.defaultValue,
          parameter: slot.parameter,
          argumentPosition: null,
          restElementPosition: null,
          activation: 'argument-undefined',
          uses: parameterUses(slot.parameter),
          elementUses: []
        })
  if (layout.receiver.kind === 'expression')
    entries.push({
      value: layout.receiver.expression,
      parameter: null,
      argumentPosition: null,
      restElementPosition: null,
      activation: 'always',
      uses: receiverUses,
      elementUses: []
    })
  // An arrow still evaluates its explicit/member receiver operand, but never
  // binds it to this. Retain the discarded operand's empty continuation.
  if (layout.receiver.kind === 'lexical' && layout.receiver.source === 'arrow' && operands.receiver)
    entries.push({
      value: operands.receiver,
      parameter: null,
      argumentPosition: null,
      restElementPosition: null,
      activation: 'always',
      uses: [],
      elementUses: []
    })
  const forwarding: SourceInvocationFrame['forwarding'] =
    layout.arguments.kind === 'spread'
      ? { kind: 'unresolved', reason: 'spread-arguments' }
      : parameters.some((parameter) => !ts.isIdentifier(parameter.name))
        ? { kind: 'unresolved', reason: 'destructured-parameter' }
        : frameReads === null
          ? { kind: 'unresolved', reason: 'arguments-object' }
          : { kind: 'values', entries }
  const values =
    ts.isMethodDeclaration(body) || ts.isFunctionDeclaration(body) || ts.isFunctionExpression(body) || ts.isArrowFunction(body)
      ? callableCompletionValuesOf(flow, body)
      : null
  let completions: SourceInvocationFrame['completions'] = { kind: 'unresolved', reason: 'deferred-or-unnamed-completion' }
  if (ts.isCallChain(call)) completions = { kind: 'unresolved', reason: 'optional-call' }
  else if (values !== null) {
    const returned: ts.Expression[] = []
    let complete = true
    for (const value of values) {
      if (unwrapErasedExpression(value).kind === ts.SyntaxKind.ThisKeyword && !ts.isArrowFunction(body)) {
        if (layout.receiver.kind !== 'expression' || layout.receiver.conversion !== 'identity') {
          complete = false
          break
        }
        returned.push(layout.receiver.expression)
      } else returned.push(value)
    }
    completions = complete ? { kind: 'values', values: returned } : { kind: 'unresolved', reason: 'implicit-receiver' }
  }
  return { layout, body, parameters, receiverUses, completionSummary, forwarding, completions }
}

/** Complete uses of an actual operand across every admitted target. */
export const invocationValueUsesOf = (fact: SourceInvocationFact, value: ts.Expression): readonly ts.Expression[] | null => {
  const uses = new Set<ts.Expression>()
  for (const frame of fact.frames) {
    if (frame.forwarding.kind !== 'values') return null
    const entries = frame.forwarding.entries.filter((entry) => entry.value === value)
    if (entries.length === 0) return null
    for (const entry of entries) {
      if (entry.elementUses.length > 0) return null
      for (const use of entry.uses) uses.add(use)
    }
  }
  return [...uses]
}

export interface InvocationValueContinuation {
  readonly expression: ts.Expression
  readonly projection: 'value' | 'array-element'
}

/** Complete actual-argument continuations, retaining the rest-array element hop. */
export const invocationValueContinuationsOf = (
  fact: SourceInvocationFact,
  value: ts.Expression
): readonly InvocationValueContinuation[] | null => {
  const valueUses = new Set<ts.Expression>()
  const elementUses = new Set<ts.Expression>()
  for (const frame of fact.frames) {
    if (frame.forwarding.kind !== 'values') return null
    const entries = frame.forwarding.entries.filter((entry) => entry.value === value)
    if (entries.length === 0) return null
    for (const entry of entries) {
      for (const expression of entry.uses) valueUses.add(expression)
      for (const expression of entry.elementUses) elementUses.add(expression)
    }
  }
  return [
    ...[...valueUses].map((expression) => ({ expression, projection: 'value' as const })),
    ...[...elementUses].map((expression) => ({ expression, projection: 'array-element' as const }))
  ]
}

export const invocationCompletionValuesOf = (fact: SourceInvocationFact): readonly ts.Expression[] | null => {
  const values = new Set<ts.Expression>()
  for (const frame of fact.frames) {
    if (frame.completions.kind !== 'values') return null
    for (const value of frame.completions.values) values.add(value)
  }
  return [...values]
}

/**
 * The parameter cell one actual argument binds to in this body's frame, or
 * `null` when the frame resolves it to no single such cell.
 *
 * Which parameter an argument binds to is this contract's fact. A consumer that
 * asks it of `call.arguments` and `runtimeParametersOf` instead gets a
 * position, and a position is not the fact: it does not know that a spread
 * makes every later slot unknown, that a destructured parameter names no cell
 * at all, or that a body reading its own `arguments` object reaches the
 * argument through a cell no parameter names. The frame states all three as
 * named unresolved reasons, so a projection of it cannot forget one.
 *
 * A rest slot resolves to a parameter whose value is a FRESH ARRAY holding the
 * argument, which is a different cell from the argument; `elementUses` is how
 * the frame says so, and this projection refuses rather than hand back a
 * parameter that does not hold the value asked about.
 */
/**
 * The argument this call binds to `parameter`, or null when the frame does not
 * state exactly one.
 *
 * The mirror of `frameForwardedParameterOf`, and it lives beside it for the
 * reason §3 item 1 gives: which argument binds which parameter is the call
 * frame contract's fact, and a consumer that recomputes it from
 * `call.arguments` writes a second spelling that will disagree. A rest element,
 * a destructured element use, or anything but a single stated entry is not one
 * argument and answers null rather than guessing which.
 */
export const frameForwardedArgumentOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  body: ts.SignatureDeclaration,
  parameter: ts.ParameterDeclaration
): ts.Expression | null => {
  const frame = sourceInvocationFrame(flow, call, body, (owner) => argumentsObjectUsesAt(checker, owner))
  if (!frame || frame.forwarding.kind !== 'values') return null
  const entries = frame.forwarding.entries.filter((entry) => entry.parameter === parameter)
  if (entries.length !== 1) return null
  const entry = entries[0]!
  if (entry.restElementPosition !== null || entry.elementUses.length > 0) return null
  return entry.value
}

export const frameForwardedParameterOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  body: ts.SignatureDeclaration,
  value: ts.Expression
): ts.ParameterDeclaration | null => {
  const frame = sourceInvocationFrame(flow, call, body, (owner) => argumentsObjectUsesAt(checker, owner))
  if (!frame || frame.forwarding.kind !== 'values') return null
  const entries = frame.forwarding.entries.filter((entry) => entry.value === value)
  if (entries.length !== 1) return null
  const entry = entries[0]!
  if (entry.parameter === null || entry.restElementPosition !== null || entry.elementUses.length > 0) return null
  return entry.parameter
}
