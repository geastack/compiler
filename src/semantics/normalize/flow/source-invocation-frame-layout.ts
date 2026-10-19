import ts from 'typescript'
import type { FlowInvocationOperands, ReceiverReference, ValueFlowIndex } from './model.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { runtimeParametersOf } from './targets.js'
import {
  ordinaryOwnInvocationOperandsMatch,
  sourceInvocationReceiverOf,
  type SourceInvocationReceiverFact
} from './source-invocation-receiver.js'

export type SourceInvocationParameterSlot =
  | {
      readonly kind: 'single'
      readonly parameter: ts.ParameterDeclaration
      readonly actual: ts.Expression | null
      /** Evaluated only when the actual value is undefined, including omission. */
      readonly defaultValue: ts.Expression | null
      readonly defaultActivation: 'never' | 'always' | 'maybe'
    }
  | {
      readonly kind: 'rest'
      readonly parameter: ts.ParameterDeclaration
      readonly actuals: readonly ts.Expression[]
    }

/** Immutable source frame inventory. Value and effect queries consume these
 * positions; neither the caller's checker signature nor its inferred type can
 * change the executable frame. */
export interface SourceInvocationFrameLayout {
  readonly call: ts.CallExpression | ts.NewExpression
  readonly body: ts.SignatureDeclaration
  readonly operands: FlowInvocationOperands
  readonly receiver: SourceInvocationReceiverFact
  readonly receiverUses: readonly ReceiverReference[]
  readonly parameters: readonly ts.ParameterDeclaration[]
  readonly arguments:
    | { readonly kind: 'positional'; readonly slots: readonly SourceInvocationParameterSlot[] }
    | { readonly kind: 'spread'; readonly values: readonly ts.Expression[] }
}

/**
 * Answers per call site, as a short list rather than nested WeakMaps: a call
 * meets one or two bodies and at most a few own-operand views, and a WeakMap
 * per call node (plus one per operand view) cost more than every answer it
 * held -- tens of thousands of them on a large program.
 */
interface FrameLayoutAnswer {
  readonly operands: FlowInvocationOperands | undefined
  readonly body: ts.SignatureDeclaration
  readonly layout: SourceInvocationFrameLayout | null
}
const layouts = new WeakMap<ValueFlowIndex, WeakMap<ts.CallExpression | ts.NewExpression, readonly FrameLayoutAnswer[]>>()

const unwrapped = (expression: ts.Expression): ts.Expression => {
  let current = unwrapErasedExpression(expression)
  while (ts.isParenthesizedExpression(current)) current = unwrapErasedExpression(current.expression)
  return current
}

const isBoundUndefined = (flow: ValueFlowIndex, expression: ts.Expression): boolean => {
  const value = unwrapped(expression)
  if (!ts.isIdentifier(value) || value.text !== 'undefined') return false
  const declaration = flow.targetOf(value)?.declaration
  return !declaration || declaration.getSourceFile().hasNoDefaultLib
}

const isDefinitelyDefined = (expression: ts.Expression): boolean => {
  const value = unwrapped(expression)
  return (
    ts.isLiteralExpression(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isFunctionExpression(value) ||
    ts.isArrowFunction(value) ||
    ts.isClassExpression(value) ||
    ts.isNewExpression(value)
  )
}

const defaultActivationOf = (
  flow: ValueFlowIndex,
  actual: ts.Expression | null,
  defaultValue: ts.Expression | null
): 'never' | 'always' | 'maybe' => {
  if (!defaultValue) return 'never'
  if (actual === null || ts.isVoidExpression(unwrapped(actual)) || isBoundUndefined(flow, actual)) return 'always'
  if (isDefinitelyDefined(actual)) return 'never'
  return 'maybe'
}

export const sourceInvocationFrameLayoutOf = (
  flow: ValueFlowIndex,
  call: ts.CallExpression | ts.NewExpression,
  body: ts.SignatureDeclaration,
  ordinaryOwnOperands?: FlowInvocationOperands
): SourceInvocationFrameLayout | null => {
  if (ordinaryOwnOperands !== undefined && !ordinaryOwnInvocationOperandsMatch(call, ordinaryOwnOperands)) return null
  let calls = layouts.get(flow)
  if (!calls) layouts.set(flow, (calls = new WeakMap()))
  const answers = calls.get(call)
  if (answers) for (const answer of answers) if (answer.body === body && answer.operands === ordinaryOwnOperands) return answer.layout
  const held = calls
  // Each list exactly sized: almost every call keeps one answer, and an
  // empty array grown by `push` reserves 17 slots for it (~4 MB over a
  // 48K-line app's ~35K calls). Read again here rather than captured above,
  // so an answer the computation below remembered for this same call is kept
  // ahead of this one, as the shared array kept it.
  const remember = (layout: SourceInvocationFrameLayout | null): SourceInvocationFrameLayout | null => {
    const answer: FrameLayoutAnswer = { operands: ordinaryOwnOperands, body, layout }
    const known = held.get(call)
    held.set(call, known ? [...known, answer] : [answer])
    return layout
  }
  const site = flow.callSiteOf(call)
  if (!site || !flow.callableBodyIsIndexed(body)) return remember(null)
  const parameters = runtimeParametersOf(body)
  const operands = ordinaryOwnOperands ?? site.operands
  const args = operands.args
  const slots: SourceInvocationParameterSlot[] = parameters.map((parameter, index) =>
    parameter.dotDotDotToken
      ? { kind: 'rest', parameter, actuals: args.slice(index) }
      : {
          kind: 'single',
          parameter,
          actual: args[index] ?? null,
          defaultValue: parameter.initializer ?? null,
          defaultActivation: defaultActivationOf(flow, args[index] ?? null, parameter.initializer ?? null)
        }
  )
  const layout: SourceInvocationFrameLayout = {
    call,
    body,
    operands,
    receiver: sourceInvocationReceiverOf(flow, call, body, ordinaryOwnOperands),
    receiverUses: ts.isArrowFunction(body) ? [] : flow.receiverReferencesToDeclaration(body),
    parameters,
    arguments: args.some(ts.isSpreadElement) ? { kind: 'spread', values: args } : { kind: 'positional', slots }
  }
  return remember(layout)
}
