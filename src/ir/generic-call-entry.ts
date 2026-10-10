import { declarationOfFunction, functionId, withoutFunctionSpecialization, type FunctionId } from '../identity/ids.js'
import type { ConversionNode } from '../conversion/algebra.js'
import { transfersNativeStorage } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { representationKey, type Representation } from '../representation/model.js'
import { nativeArgumentsMatch } from './call-entry.js'
import type { CallOperation, IrBody, IrOperand } from './model.js'
import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'

/** The installed selector only changes its finite index space. Source entry
 * identity is proved separately at the invocation, never by a matching ABI.
 * @semanticCategory generic-primitive
 */
export const nativeGenericSelectorMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (
    !node ||
    representationKey(node.source) !== representationKey(source) ||
    representationKey(node.target) !== representationKey(target) ||
    target.kind !== 'generic-function-set' ||
    target.members.length === 0 ||
    new Set(target.members).size !== target.members.length ||
    node.capability.kind !== 'atom' ||
    node.capability.materializer.id !== 'generic-function-set::remap' ||
    node.capability.materializer.nativeFieldProtocol !== 'unused' ||
    node.capability.materializer.allocates ||
    node.capability.classifier.id !== 'generic-function-set::index' ||
    node.capability.classifier.domain !== `generic-function-set:${representationKey(source)}->${representationKey(target)}` ||
    node.capability.classifier.domain !== node.capability.materializer.domain
  )
    return false
  return source.kind === 'generic-function-set'
    ? source.members.length > 0 && source.members.every((member) => target.members.includes(member))
    : target.members.length === 1 &&
        ['function', 'function-family', 'function-value-family', 'function-value-dispatch'].includes(source.kind)
}

const frameConversionMatches = (
  operation: CallOperation,
  role: 'call-argument' | 'call-result',
  source: Representation,
  target: Representation,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined
): boolean => {
  if (representationKey(source) === representationKey(target)) return true
  const recipe = operation.conversionRecipes?.find(
    (one) =>
      one.role === role &&
      representationKey(one.source) === representationKey(source) &&
      representationKey(one.target) === representationKey(target)
  )
  const node = recipe && conversions?.nodeById(recipe.conversion)
  return (
    node !== null &&
    node !== undefined &&
    representationKey(node.source) === representationKey(source) &&
    representationKey(node.target) === representationKey(target) &&
    transfersNativeStorage(node.capability)
  )
}

/** A complete selector family must agree with the observed allocator roots,
 * the selected specialization and every actual physical frame.
 * @semanticCategory generic-primitive
 */
export const nativeGenericCallEntriesOf = (
  operation: CallOperation,
  origins: ReadonlySet<FunctionId>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): readonly { readonly functionId: FunctionId; readonly arguments: readonly IrOperand[] }[] | null => {
  const selector = operation.callee.representation
  const family = operation.family
  if (
    selector.kind !== 'generic-function-set' ||
    !selector.members.length ||
    new Set(selector.members).size !== selector.members.length ||
    family?.length !== selector.members.length ||
    !origins.size ||
    operation.argumentsAreSpread ||
    operation.receiver !== null ||
    family.some((member) => !selector.members.includes(member.member))
  )
    return null
  const rows = new Map(family.map((member) => [member.member, member]))
  if (rows.size !== selector.members.length) return null
  for (const origin of origins) {
    const root = withoutFunctionSpecialization(origin)
    const row = rows.get(declarationOfFunction(root))
    if (!row || (origin !== root && row.functionId !== origin)) return null
  }
  const entries: { readonly functionId: FunctionId; readonly arguments: readonly IrOperand[] }[] = []
  for (const member of selector.members) {
    const selected = rows.get(member)!
    const body = bodyOf(selected.functionId)
    const abi = body?.abi
    if (
      withoutFunctionSpecialization(selected.functionId) !== functionId(member) ||
      body?.sourceOwner !== selected.functionId ||
      !abi ||
      abi.receiver !== null ||
      abi.restFrom !== null ||
      (operation.thisArgument !== undefined && !nativeBodyIgnoresLogicalReceiver(body))
    )
      return null
    const received = operation.arguments.slice(0, abi.parameters.length)
    if (
      !nativeArgumentsMatch(abi, received, conversions, 'native-transfer') ||
      !received.every((argument, index) =>
        frameConversionMatches(operation, 'call-argument', argument.representation, abi.parameters[index]!.value, conversions)
      )
    )
      return null
    if (operation.result) {
      const source: Representation = abi.result.kind === 'void' ? { kind: 'undefined' } : abi.result
      const target = operation.result.representation
      if (!frameConversionMatches(operation, 'call-result', source, target, conversions)) return null
    }
    if ([...origins].some((origin) => withoutFunctionSpecialization(origin) === functionId(member)))
      entries.push({ functionId: selected.functionId, arguments: received })
  }
  return entries.length ? entries : null
}
