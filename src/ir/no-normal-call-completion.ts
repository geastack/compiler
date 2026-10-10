import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { representationKey } from '../representation/model.js'
import type { ConstantOperation, IrBlockId, IrBody, IrOperand, IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

type Primitive = string | boolean | null | undefined
interface KnownPrimitive {
  readonly value: Primitive
}

const constantOf = (operation: ConstantOperation): KnownPrimitive | undefined => {
  switch (operation.literal) {
    case 'string':
      return { value: operation.text }
    case 'boolean':
      return operation.text === 'true' ? { value: true } : operation.text === 'false' ? { value: false } : undefined
    case 'null':
      return { value: null }
    case 'undefined':
      return { value: undefined }
    default:
      return undefined
  }
}

/** A literal can cross envelopes only through the exact census recipe's content-preservation fact. */
const primitiveTransportOf = (
  operation: Extract<IrOperation, { kind: 'convert' }>,
  conversions: Pick<ConversionCensus, 'nodeById'>
): ConversionNode | null => {
  if (operation.rebuild !== undefined) return null
  const node = conversions.nodeById(operation.conversionUse)
  if (
    node === null ||
    representationKey(node.source) !== representationKey(operation.source.representation) ||
    representationKey(node.target) !== representationKey(operation.result.representation) ||
    !recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById)
  )
    return null
  return node.capability.kind === 'identity' ||
    ('materializer' in node.capability && node.capability.materializer.primitiveIdentityTransport === 'preserved')
    ? node
    : null
}

export const literalPrimitiveOf = (
  operand: IrOperand,
  definitionOf: (value: IrValueId) => IrOperation | null,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  citations: Set<string>,
  visited = new Set<IrValueId>()
): KnownPrimitive | undefined => {
  if (visited.has(operand.value)) return undefined
  visited.add(operand.value)
  const operation = definitionOf(operand.value)
  const result = operation === null ? null : resultOfIrOperation(operation)
  if (
    operation === null ||
    result?.id !== operand.value ||
    representationKey(result.representation) !== representationKey(operand.representation)
  )
    return undefined
  if (operation.kind === 'constant') return constantOf(operation)
  if (operation.kind !== 'convert') return undefined
  const node = primitiveTransportOf(operation, conversions)
  if (node === null) return undefined
  const value = literalPrimitiveOf(operation.source, definitionOf, conversions, citations, visited)
  if (value !== undefined) citations.add(node.id)
  return value
}

/**
 * Evaluate only immutable primitive observations of the actual fixed call frame.
 * Unknown branches are explored on both sides; a reachable return, loop or complex
 * exception region makes the result unknown. Effectful operations remain executable.
 */
export const noNormalCallCompletionOf = (
  body: IrBody,
  args: readonly IrOperand[],
  definitionOf: (value: IrValueId) => IrOperation | null,
  conversions: Pick<ConversionCensus, 'nodeById'>
): readonly string[] | null => {
  if (
    body.abi === null ||
    body.abi.receiver !== null ||
    body.abi.restFrom !== null ||
    body.async ||
    body.generator ||
    body.tryRegions.length > 0 ||
    (body.iteratorCloseRegions?.length ?? 0) > 0 ||
    args.length !== body.abi.parameters.length
  )
    return null
  if (
    args.some((argument, ordinal) => representationKey(argument.representation) !== representationKey(body.abi!.parameters[ordinal]!.value))
  )
    return null
  const citations = new Set<string>()
  const parameters = args.map((argument) => literalPrimitiveOf(argument, definitionOf, conversions, citations))
  let states = 0
  let throws = 0
  const visit = (
    id: IrBlockId,
    predecessor: IrBlockId | null,
    inherited: ReadonlyMap<IrValueId, KnownPrimitive>,
    cells: ReadonlyMap<DeclarationId, KnownPrimitive>,
    path: ReadonlySet<IrBlockId>
  ): boolean => {
    if (++states > 256 || path.has(id)) return false
    const block = body.blocks.get(id)
    if (block === undefined) return false
    const seen = new Set(path).add(id)
    const values = new Map(inherited)
    const bindings = new Map(cells)
    for (const operation of block.operations) {
      let known: KnownPrimitive | undefined
      switch (operation.kind) {
        case 'parameter':
          if (
            body.abi?.parameters[operation.ordinal] === undefined ||
            representationKey(body.abi.parameters[operation.ordinal]!.value) !== representationKey(operation.result.representation)
          )
            return false
          known = parameters[operation.ordinal]
          break
        case 'constant':
          known = constantOf(operation)
          break
        case 'binding-write': {
          const value = values.get(operation.value.value)
          if (value === undefined) bindings.delete(operation.declaration)
          else bindings.set(operation.declaration, value)
          break
        }
        case 'binding-read':
          known = bindings.get(operation.declaration)
          break
        case 'convert': {
          const value = values.get(operation.source.value)
          const node = value === undefined ? null : primitiveTransportOf(operation, conversions)
          if (node !== null) {
            known = value
            citations.add(node.id)
          } else bindings.clear()
          break
        }
        case 'phi': {
          const input = operation.incoming.find((edge) => edge.block === predecessor)
          if (input !== undefined && representationKey(input.value.representation) === representationKey(operation.result.representation))
            known = values.get(input.value.value)
          break
        }
        case 'compute': {
          const left = operation.operands[0] === undefined ? undefined : values.get(operation.operands[0].value)
          const right = operation.operands[1] === undefined ? undefined : values.get(operation.operands[1].value)
          if (
            operation.form === 'equality' &&
            left !== undefined &&
            right !== undefined &&
            (operation.operator === '===' || operation.operator === '!==')
          )
            known = { value: (left.value === right.value) === (operation.operator === '===') }
          else if (operation.form === 'unary' && operation.operator === '!' && left !== undefined) known = { value: !left.value }
          else if (
            !(operation.form === 'equality' && (operation.operator === '===' || operation.operator === '!==')) &&
            !(
              ['unary', 'binary', 'update'].includes(operation.form) &&
              operation.operands.every((operand) => ['scalar', 'string', 'null', 'undefined'].includes(operand.representation.kind))
            )
          )
            bindings.clear()
          break
        }
        case 'test': {
          const value = values.get(operation.value.value)
          if (value !== undefined)
            known = {
              value:
                operation.predicate === 'to-boolean'
                  ? !!value.value
                  : operation.predicate === 'is-present'
                    ? value.value !== null && value.value !== undefined
                    : value.value !== undefined
            }
          break
        }
        default:
          bindings.clear()
      }
      const result = resultOfIrOperation(operation)
      if (result !== null) {
        if (known === undefined) values.delete(result.id)
        else values.set(result.id, known)
      }
    }
    const end = block.terminator
    switch (end.kind) {
      case 'throw':
        throws++
        return true
      case 'return':
        return false
      case 'jump':
        return visit(end.target, id, values, bindings, seen)
      case 'branch': {
        const truth = values.get(end.condition.value)
        if (truth !== undefined) return visit(truth.value ? end.whenTrue : end.whenFalse, id, values, bindings, seen)
        return visit(end.whenTrue, id, values, bindings, seen) && visit(end.whenFalse, id, values, bindings, seen)
      }
      default:
        return false
    }
  }
  return visit(body.entry, null, new Map(), new Map(), new Set()) && throws > 0 ? [...citations].sort() : null
}
