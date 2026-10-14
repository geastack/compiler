import ts from 'typescript'
import type { ValueFlowIndex, ValueWrite } from './flow/model.js'
import { classifyCallableMention } from './flow/callable-reach.js'
import { isModuleExportedDeclaration } from './flow/targets.js'
import { intrinsicArrayCallbackFrameOf, type IntrinsicArrayCallbackFrame } from './flow/intrinsic-array-callback-frames.js'
import type { IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'

/**
 * Who invokes a named callback other than its counted direct calls: a stated
 * higher-order signature, or an intrinsic Array method the callback is handed
 * to (`lights.sort( byShadow )`). The intrinsic has no source signature for the
 * flow index to record an argument edge into, so its frame is the contract.
 */
export type CallbackParameterContract =
  | {
      readonly signature: ts.Signature
      readonly location: ts.CallExpression | ts.NewExpression
    }
  | {
      readonly intrinsic: IntrinsicArrayCallbackFrame
      /**
       * What the frame's arguments depend on: the method itself and the array
       * indices (a hole read falls through to the prototype). The receiver's
       * own shape is proved by its census type, not by this obligation.
       */
      readonly requirements: readonly IntrinsicProtocolRequirement[]
    }

/**
 * The type a callback receives at `position`.
 *
 * A signature is resolved at the receiving call so instantiated generic
 * contracts stay instantiated. An intrinsic frame's arguments are read off the
 * receiver as the consuming census types it -- `receiverTypeAt` -- because the
 * receiver of `lights.sort( cmp )` is commonly an unannotated JavaScript
 * parameter the checker calls `any` while the census has closed it to
 * `Light[]`. Only a receiver with exactly one non-nullish arm, an Array type,
 * answers (a nullish receiver throws before any callback runs); the
 * accumulator of `reduce` depends on the callback's own completions and
 * refuses.
 */
export const callbackContractParameterType = (
  checker: ts.TypeChecker,
  contract: CallbackParameterContract,
  position: number,
  receiverTypeAt: (expression: ts.Expression) => ts.Type | null = (expression) => checker.getTypeAtLocation(expression)
): ts.Type | null => {
  if ('intrinsic' in contract) return intrinsicFrameArgumentType(checker, contract.intrinsic, position, receiverTypeAt)
  const parameter = contract.signature.parameters[position]
  const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0]
  if (!parameter || !declaration || !ts.isParameter(declaration) || declaration.dotDotDotToken) return null
  return checker.getTypeOfSymbolAtLocation(parameter, contract.location)
}

/** The methods that visit a hole as `undefined` rather than skipping it. */
const HOLE_VISITING_METHODS: ReadonlySet<string> = new Set(['find', 'findIndex', 'findLast', 'findLastIndex'])

const intrinsicFrameArgumentType = (
  checker: ts.TypeChecker,
  frame: IntrinsicArrayCallbackFrame,
  position: number,
  receiverTypeAt: (expression: ts.Expression) => ts.Type | null
): ts.Type | null => {
  const argument = frame.arguments.find((entry) => entry.position === position)
  if (!argument) return null
  if (argument.source.kind === 'array-index') return checker.getNumberType()
  if (argument.source.kind === 'reduce-accumulator') return null
  const receiver = receiverTypeAt(frame.receiver)
  if (!receiver || (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
  const arrays = (receiver.isUnion() ? receiver.types : [receiver]).filter(
    (arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0
  )
  const array = arrays.length === 1 ? arrays[0]! : null
  if (!array || !checker.isArrayType(array)) return null
  if (argument.source.kind === 'receiver') return array
  const element = checker.getTypeArguments(array as ts.TypeReference)[0]
  if (!element) return null
  return HOLE_VISITING_METHODS.has(frame.method) ? checker.getNullableType(element, ts.TypeFlags.Undefined) : element
}

/**
 * The intrinsic Array frame a mention of the callback is the callback operand
 * of, or null when the mention is anything else.
 */
const intrinsicArrayContractAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, reference: ts.Node): CallbackParameterContract | null => {
  const call = reference.parent
  if (!ts.isCallExpression(call) || call.arguments[0] !== reference) return null
  const site = flow.callSiteOf(call)
  if (!site) return null
  const described = intrinsicArrayCallbackFrameOf(checker, flow, site)
  if (described.kind !== 'frame' || described.frame.callback !== reference) return null
  const frame = described.frame
  return {
    intrinsic: frame,
    requirements: [{ intrinsic: 'Array', prototypeKeys: { names: [frame.memberKey], arrayIndices: true }, location: frame.call }]
  }
}

/**
 * Every stated callback input contract receiving a local named function.
 * These signatures are additional caller evidence, never a substitute for
 * its direct calls. Unknown escapes fail closed. In particular a receiving
 * `(value: any) => void` signature is retained so the parameter join sees the
 * open input rather than inferring from only the convenient typed boundary.
 */
export const callbackParameterContractsFor = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.SignatureDeclaration,
  countedCalls: ReadonlySet<ts.CallExpression | ts.NewExpression>
): readonly CallbackParameterContract[] | null => {
  if (!ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body) return null
  if ((ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) !== 0) return null
  const symbol = checker.getSymbolAtLocation(declaration.name)
  if (!symbol || symbol.declarations?.length !== 1) return null

  const signatures: CallbackParameterContract[] = []
  const acceptedArguments = new Set<ts.Expression>()
  const flows = new Set([...flow.flowsFromDeclaration(declaration), ...flow.flowsFromSymbol(symbol)])
  const contractAt = (write: ValueWrite): readonly CallbackParameterContract[] | null => {
    if (write.edge !== 'call-argument' || write.slot !== 'whole' || !write.value) return null
    const call = write.value.parent
    if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return null
    const args = call.arguments
    if (!args || args.some(ts.isSpreadElement)) return null
    const position = args.indexOf(write.value)
    if (position < 0) return null
    const signature = checker.getResolvedSignature(call)
    const parameter = signature?.parameters[position]
    if (!parameter) return null
    const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0]
    if (!parameterDeclaration || !ts.isParameter(parameterDeclaration) || parameterDeclaration.dotDotDotToken) return null
    const type = checker.getTypeOfSymbolAtLocation(parameter, call)
    // An optional callable is still a stated contract; any other alternative
    // is an open destination, not permission to discard that incoming use.
    const arms = type.isUnion() ? type.types : [type]
    const result: CallbackParameterContract[] = []
    for (const arm of arms) {
      if ((arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0) continue
      if ((arm.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return null
      const calls = checker.getSignaturesOfType(arm, ts.SignatureKind.Call)
      if (calls.length === 0) return null
      result.push(...calls.map((signature) => ({ signature, location: call })))
    }
    return result.length === 0 ? null : result
  }
  for (const write of flows) {
    const contracts = contractAt(write)
    if (contracts === null || write.value === null) return null
    acceptedArguments.add(write.value)
    signatures.push(...contracts)
  }
  // An export-list alias is not an expression reference in the value-flow
  // index. Its checker identity still publishes this callable to open callers.
  if (isModuleExportedDeclaration(checker, declaration, symbol)) return null

  const references = new Set([...flow.referencesToDeclaration(declaration), ...flow.referencesToSymbol(symbol)])
  for (const reference of references) {
    if (acceptedArguments.has(reference)) continue
    const mention = classifyCallableMention(checker, reference, declaration.name)
    if (mention.kind === 'inert') continue
    if (mention.kind === 'call' && countedCalls.has(mention.call)) continue
    const intrinsic = intrinsicArrayContractAt(checker, flow, reference)
    if (intrinsic === null) return null
    signatures.push(intrinsic)
  }
  return signatures.length === 0 ? null : signatures
}

/** A directly supplied JSX callback receives the attribute's stated argument, including when its annotation exposes fewer fields. */
export const inlineJsxCallbackParameterType = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (!parameter.type || !ts.isTypeLiteralNode(parameter.type) || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return null
  const callback = parameter.parent
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return null
  if (!ts.isJsxExpression(callback.parent) || callback.parent.expression !== callback || !ts.isJsxAttribute(callback.parent.parent))
    return null
  const contextual = checker.getContextualType(callback)
  const signatures = contextual ? checker.getNonNullableType(contextual).getCallSignatures() : []
  if (signatures.length !== 1) return null
  const source = signatures[0]?.parameters[callback.parameters.indexOf(parameter)]
  if (!source) return null
  const expected = checker.getTypeOfSymbolAtLocation(source, callback)
  if ((expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return null
  return checker.isTypeAssignableTo(expected, checker.getTypeFromTypeNode(parameter.type)) ? expected : null
}
