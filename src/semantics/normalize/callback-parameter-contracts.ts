import ts from 'typescript'
import type { ValueFlowIndex, ValueWrite } from './flow/model.js'
import { classifyCallableMention } from './flow/callable-reach.js'
import { isModuleExportedDeclaration } from './flow/targets.js'

export interface CallbackParameterContract {
  readonly signature: ts.Signature
  readonly location: ts.CallExpression | ts.NewExpression
}

/** Resolve at the receiving call so instantiated generic contracts stay instantiated. */
export const callbackContractParameterType = (
  checker: ts.TypeChecker,
  contract: CallbackParameterContract,
  position: number
): ts.Type | null => {
  const parameter = contract.signature.parameters[position]
  const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0]
  if (!parameter || !declaration || !ts.isParameter(declaration) || declaration.dotDotDotToken) return null
  return checker.getTypeOfSymbolAtLocation(parameter, contract.location)
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
  if (signatures.length === 0) return null

  // An export-list alias is not an expression reference in the value-flow
  // index. Its checker identity still publishes this callable to open callers.
  if (isModuleExportedDeclaration(checker, declaration, symbol)) return null

  const references = new Set([...flow.referencesToDeclaration(declaration), ...flow.referencesToSymbol(symbol)])
  for (const reference of references) {
    if (acceptedArguments.has(reference)) continue
    const mention = classifyCallableMention(checker, reference, declaration.name)
    if (mention.kind === 'inert') continue
    if (mention.kind === 'call' && countedCalls.has(mention.call)) continue
    return null
  }
  return signatures
}
