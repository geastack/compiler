import ts from 'typescript'
import type { FlowInvocationOperands, ReceiverReference, ValueFlowIndex } from './model.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { runtimeParametersOf } from './targets.js'
import { sourceInvocationReceiverOf, type SourceInvocationReceiverFact } from './source-invocation-receiver.js'

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

const layouts = new WeakMap<
  ValueFlowIndex,
  WeakMap<ts.CallExpression | ts.NewExpression, WeakMap<ts.SignatureDeclaration, SourceInvocationFrameLayout | null>>
>()

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
  body: ts.SignatureDeclaration
): SourceInvocationFrameLayout | null => {
  let calls = layouts.get(flow)
  if (!calls) layouts.set(flow, (calls = new WeakMap()))
  let bodies = calls.get(call)
  if (!bodies) calls.set(call, (bodies = new WeakMap()))
  if (bodies.has(body)) return bodies.get(body)!
  const site = flow.callSiteOf(call)
  if (!site || !flow.callableBodyIsIndexed(body)) {
    bodies.set(body, null)
    return null
  }
  const parameters = runtimeParametersOf(body)
  const args = site.operands.args
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
    operands: site.operands,
    receiver: sourceInvocationReceiverOf(flow, call, body),
    receiverUses: ts.isArrowFunction(body) ? [] : flow.receiverReferencesToDeclaration(body),
    parameters,
    arguments: args.some(ts.isSpreadElement) ? { kind: 'spread', values: args } : { kind: 'positional', slots }
  }
  bodies.set(body, layout)
  return layout
}
