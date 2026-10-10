import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeUnboundMethodContractOf } from '../conversion/native-method.js'
import type { FunctionId, SemanticResultId, IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'
import { identityOperandOf, immutableBindingInitializerOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { CallOperation, ConvertOperation, IrOperation } from './model.js'
import { nativeMethodReadSourceOf, type NativeMethodReadAuthority } from './native-method-read-source.js'

/**
 * A transferred value's source Function identity, independent of a structurally equal callable parameter type.
 * @semanticCategory generic-primitive
 */
export type NativeCallableSourceProof = {
  readonly origin: SemanticResultId
  readonly role: string
  readonly ordinal: number
} & ({ readonly callable: FunctionId; readonly methodRead?: never } | { readonly methodRead: SemanticResultId; readonly callable?: never })

const nativeCallableValueBoundary = (operation: SemanticOperation, operand: SemanticOperand): boolean => {
  switch (operation.family) {
    case 'invocation':
      return operand.role === 'argument'
    case 'property':
      return (operation.internalMethod === 'set' || operation.internalMethod === 'define-own-property') && operand.role === 'value'
    case 'binding':
      return (
        (operation.action === 'initialize' && operand.role === 'initializer') || (operation.action === 'write' && operand.role === 'value')
      )
    case 'control':
      return operation.form === 'return' && operand.role === 'value'
    case 'computation':
      return operation.form === 'assignment' && operation.operator === '=' && operand.role === 'value'
    case 'allocation':
      return operation.allocated === 'array-literal' && operand.role === 'element'
    case 'class-lifecycle':
      return (operation.event === 'define-field' && operand.role === 'initializer') || operand.role === 'method'
    default:
      return false
  }
}

/** Only a known native source body can install a new future logical-this frame at a semantic value boundary. */
export const nativeCallableSourceOf = (
  operation: SemanticOperation,
  operand: SemanticOperand,
  source: Representation,
  target: Representation,
  origins: ReadonlyMap<SemanticResultId, FunctionId>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  reads?: NativeMethodReadAuthority
): NativeCallableSourceProof | null => {
  if (!nativeCallableValueBoundary(operation, operand) || operand.source.kind !== 'result') return null
  const origin = operand.source.result
  if (
    !operation.operands.some(
      (candidate) =>
        candidate.role === operand.role &&
        candidate.ordinal === operand.ordinal &&
        candidate.source.kind === 'result' &&
        candidate.source.result === origin
    )
  )
    return null
  const callable = origins.get(origin)
  const physical = callable === undefined ? undefined : abis.get(callable)
  const held = abiOfCallee(source)
  if (nativeUnboundMethodContractOf(source, target) === null) return null
  if (callable !== undefined && physical !== undefined && held !== null && abiKey(held) === abiKey(physical))
    return { origin, callable, role: operand.role, ordinal: operand.ordinal }
  const methodRead = reads === undefined ? null : nativeMethodReadSourceOf(origin, source, reads)
  return methodRead === null ? null : { origin, methodRead, role: operand.role, ordinal: operand.ordinal }
}

export const nativeCallableSourceAliasesOf = (
  graph: Pick<SemanticGraph, 'results' | 'operations'>,
  origin: SemanticResultId
): ReadonlySet<SemanticResultId> => {
  const aliases = new Set<SemanticResultId>()
  let current: SemanticResultId | null = origin
  while (current !== null && !aliases.has(current)) {
    aliases.add(current)
    const id = graph.results.get(current)
    const operation = id === undefined ? undefined : graph.operations.get(id)
    const source = operation === undefined ? undefined : (identityOperandOf(operation) ?? immutableBindingInitializerOf(graph, operation))
    current = source?.source.kind === 'result' ? source.source.result : null
  }
  return aliases
}

/** The semantic source, physical body, actual SSA producer and selected contextual recipe must agree. */
export const nativeCallableSourceMatches = (
  operation: ConvertOperation,
  semantic: SemanticOperation | null,
  definition: IrOperation | null,
  origins: ReadonlyMap<SemanticResultId, FunctionId>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  conversions: Pick<ConversionCensus, 'nodeById' | 'nativeMethodFor'>,
  graph?: Pick<SemanticGraph, 'results' | 'operations'>,
  reads?: NativeMethodReadAuthority
): boolean => {
  const proof = operation.nativeCallableSource
  if (proof === undefined || semantic === null || operation.rebuild !== undefined) return false
  if (definition === null || !('result' in definition) || definition.result?.id !== operation.source.value || definition.lineage == null)
    return false
  if (
    !(graph === undefined
      ? definition.lineage === proof.origin
      : nativeCallableSourceAliasesOf(graph, proof.origin).has(definition.lineage))
  )
    return false
  const operand = semantic.operands.find((candidate) => candidate.role === proof.role && candidate.ordinal === proof.ordinal)
  if (operand === undefined) return false
  const expected = nativeCallableSourceOf(
    semantic,
    operand,
    operation.source.representation,
    operation.result.representation,
    origins,
    abis,
    reads
  )
  if (
    expected === null ||
    expected.origin !== proof.origin ||
    expected.callable !== proof.callable ||
    expected.methodRead !== proof.methodRead
  )
    return false
  if (proof.methodRead !== undefined) {
    if (definition.kind === 'get') {
      if (definition.lineage !== proof.methodRead) return false
    } else {
      if (definition.kind !== 'binding-read' || graph === undefined) return false
      const definingOperation = graph.results.get(definition.lineage)
      const read = definingOperation === undefined ? undefined : graph.operations.get(definingOperation)
      if (
        read?.family !== 'binding' ||
        read.action !== 'read' ||
        read.declaration !== definition.declaration ||
        immutableBindingInitializerOf(graph, read) === undefined
      )
        return false
    }
  }
  const actualOrigin =
    definition?.kind === 'allocate-callable'
      ? definition.functionId
      : definition?.lineage === null || definition?.lineage === undefined
        ? null
        : (origins.get(definition.lineage) ?? null)
  if (proof.methodRead === undefined && actualOrigin !== proof.callable) return false
  const canonical = conversions.nativeMethodFor(operation.source.representation, operation.result.representation)
  return canonical !== null && canonical === conversions.nodeById(operation.conversionUse)
}

/**
 * An operation's known source bodies, distinct from its public callable carrier.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableEntryProof {
  readonly ordinal: number
  readonly callables: readonly FunctionId[]
}

/** Future callback slots can change this only for a published exact source-body identity. */
export const nativeCallableArgumentEntryOf = (
  operation: CallOperation,
  ordinal: number,
  target: Representation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  abis: ReadonlyMap<FunctionId, CallableAbi>
): NativeCallableEntryProof | null => {
  const argument = operation.arguments[ordinal]
  if (argument === undefined || nativeUnboundMethodContractOf(argument.representation, target) === null) return null
  const source = definitionOf(argument.value)
  const identity = source?.kind === 'binding-read' || source?.kind === 'get' ? source.closedCallable : undefined
  const callables =
    source?.kind === 'allocate-callable'
      ? [source.functionId]
      : identity?.kind === 'exact'
        ? [identity.functionId]
        : identity?.kind === 'closed-family'
          ? identity.functionIds
          : []
  const held = abiOfCallee(argument.representation)
  if (
    held === null ||
    callables.length === 0 ||
    callables.some((callable) => {
      const physical = abis.get(callable)
      return physical === undefined || abiKey(physical) !== abiKey(held)
    })
  )
    return null
  return { ordinal, callables: [...new Set(callables)].sort() }
}
