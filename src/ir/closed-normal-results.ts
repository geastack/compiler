import type { ConversionNode } from '../conversion/algebra.js'
import { conversionNodeIdOf, type ConversionCensus } from '../conversion/nodes.js'
import { nativeSumPlan, nativeSumPreservesPayload } from '../conversion/native-sum.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, RegionId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { carriesNativeUndefined, carriesUndefined, representationKey, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { dominatorTreeOf, isVisible, type DefinitionSite } from './dominance.js'
import type { BindingWriteOperation, IrBody, IrNonTerminatorOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

export interface ClosedNormalResultInput {
  readonly conversions: Pick<ConversionCensus, 'nodeById'>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
}

export interface ClosedNormalResultFacts {
  readonly undefinedValues: ReadonlySet<IrValueId>
  readonly truthiness: ReadonlyMap<IrValueId, boolean>
}

const nativeUndefinedCarrier = (value: Representation): boolean =>
  value.kind !== 'dynamic' && value.kind !== 'void' && carriesUndefined(value)

/** Only an exact existing recipe can carry an actual undefined value through a changed native representation. */
const preservesUndefined = (
  source: Representation,
  target: Representation,
  input: ClosedNormalResultInput,
  node?: ConversionNode | null
): boolean => {
  if (!nativeUndefinedCarrier(source) || !nativeUndefinedCarrier(target)) return false
  if (
    node !== undefined &&
    (node === null ||
      input.conversions.nodeById(node.id) !== node ||
      representationKey(node.source) !== representationKey(source) ||
      representationKey(node.target) !== representationKey(target))
  )
    return false
  if (representationKey(source) === representationKey(target)) return node === undefined || node?.capability.kind === 'identity'
  const recipe = node ?? input.conversions.nodeById(conversionNodeIdOf(source, target))
  if (
    recipe === null ||
    recipe === undefined ||
    representationKey(recipe.source) !== representationKey(source) ||
    representationKey(recipe.target) !== representationKey(target) ||
    input.conversions.nodeById(recipe.id) !== recipe ||
    !recipeIsMaterializableWithoutPriorSourceGuard(recipe, input.conversions.nodeById) ||
    !('materializer' in recipe.capability) ||
    recipe.capability.materializer.nativePayloadTransport !== 'preserved'
  )
    return false
  const sum = nativeSumPlan(source, target)
  return (sum !== null && nativeSumPreservesPayload(sum)) || (source.kind === 'undefined' && carriesNativeUndefined(target))
}

interface WriteSite extends DefinitionSite {
  readonly body: IrBody
  readonly operation: BindingWriteOperation
}

/**
 * Normal-return facts come from executed source bodies, never from their declared result types.
 * Calls and conversions remain in the IR: a fact describes only the value after normal completion.
 */
export const closedNormalResultsOf = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  graph: Pick<SemanticGraph, 'operations'>,
  input: ClosedNormalResultInput
): ClosedNormalResultFacts => {
  const undefinedValues = new Set<IrValueId>()
  const truthiness = new Map<IrValueId, boolean>()
  const strings = new Map<IrValueId, string>()
  const typeofNames = new Set<IrValueId>()
  const sourceBodies = new Map<FunctionId | RegionId, IrBody[]>()
  const writes = new Map<DeclarationId, WriteSite[]>()
  const renewed = new Set<DeclarationId>()
  const immutable = new Set<DeclarationId>()
  const mutable = new Set<DeclarationId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding') continue
    if (operation.mutable || operation.external !== undefined) mutable.add(operation.declaration)
    else if (operation.action === 'initialize' || operation.action === 'declare') immutable.add(operation.declaration)
  }
  for (const declaration of mutable) immutable.delete(declaration)

  const operations = new Map<IrBody, readonly IrNonTerminatorOperation[]>()
  const definitions = new Map<IrValueId, IrNonTerminatorOperation>()
  const sites = new Map<IrNonTerminatorOperation, DefinitionSite>()
  for (const body of bodies.values()) {
    const entries = sourceBodies.get(body.sourceOwner) ?? []
    entries.push(body)
    sourceBodies.set(body.sourceOwner, entries)
    const reachable = dominatorTreeOf(body).reachable
    const listed: IrNonTerminatorOperation[] = []
    for (const block of body.blocks.values())
      for (const [position, operation] of block.operations.entries()) {
        const site = { block: block.id, position }
        if (operation.kind === 'binding-write') {
          const list = writes.get(operation.declaration) ?? []
          list.push({ ...site, body, operation })
          writes.set(operation.declaration, list)
        } else if (operation.kind === 'binding-renew') renewed.add(operation.declaration)
        if (!reachable.has(block.id)) continue
        listed.push(operation)
        sites.set(operation, site)
        const result = resultOfIrOperation(operation)
        if (result !== null) definitions.set(result.id, operation)
        if (operation.kind === 'constant') {
          if (operation.literal === 'undefined' && nativeUndefinedCarrier(operation.result.representation))
            undefinedValues.add(operation.result.id)
          if (operation.literal === 'string') strings.set(operation.result.id, operation.text)
        }
      }
    operations.set(body, listed)
  }

  const returnedUndefined = new Set<FunctionId | RegionId>()
  let changed = true
  while (changed) {
    changed = false
    for (const body of bodies.values()) {
      const dominance = dominatorTreeOf(body)
      for (const operation of operations.get(body) ?? []) {
        let absent = false
        let truth: boolean | undefined
        if (operation.kind === 'convert' && operation.rebuild === undefined && undefinedValues.has(operation.source.value)) {
          const node = input.conversions.nodeById(operation.conversionUse)
          absent = node !== null && preservesUndefined(operation.source.representation, operation.result.representation, input, node)
        } else if (operation.kind === 'phi' && operation.incoming.length > 0) {
          absent = operation.incoming.every(
            (edge) =>
              undefinedValues.has(edge.value.value) && preservesUndefined(edge.value.representation, operation.result.representation, input)
          )
          const first = truthiness.get(operation.incoming[0]!.value.value)
          if (first !== undefined && operation.incoming.every((edge) => truthiness.get(edge.value.value) === first)) truth = first
        } else if (operation.kind === 'binding-read' && immutable.has(operation.declaration) && !renewed.has(operation.declaration)) {
          const write = writes.get(operation.declaration)
          const placement = input.placements.get(operation.declaration)?.storage
          const site = sites.get(operation)!
          absent =
            write?.length === 1 &&
            write[0]!.body === body &&
            (placement?.kind === 'local' || placement?.kind === 'region') &&
            placement.owner === body.sourceOwner &&
            isVisible(write[0]!, site.block, site.position, dominance) &&
            undefinedValues.has(write[0]!.operation.value.value) &&
            preservesUndefined(write[0]!.operation.value.representation, operation.result.representation, input)
        } else if (operation.kind === 'call' && operation.result !== null && operation.closedCallee?.kind === 'exact') {
          const callable = operation.closedCallee.functionId
          const producer = definitions.get(operation.callee.value)
          const source = sourceBodies.get(callable)
          const identified =
            producer?.kind === 'allocate-callable'
              ? producer.functionId === callable
              : (producer?.kind === 'binding-read' || producer?.kind === 'get') &&
                producer.closedCallable?.kind === 'exact' &&
                producer.closedCallable.functionId === callable
          absent =
            identified &&
            returnedUndefined.has(callable) &&
            source?.length === 1 &&
            source[0]!.abi !== null &&
            preservesUndefined(source[0]!.abi!.result, operation.result.representation, input)
        } else if (operation.kind === 'compute') {
          const [left, right] = operation.operands
          if (operation.form === 'typeof' && left !== undefined && undefinedValues.has(left.value) && !strings.has(operation.result.id)) {
            strings.set(operation.result.id, 'undefined')
            typeofNames.add(operation.result.id)
            changed = true
          } else if (operation.form === 'equality' && left !== undefined && right !== undefined) {
            const leftText = strings.get(left.value)
            const rightText = strings.get(right.value)
            if (
              leftText !== undefined &&
              rightText !== undefined &&
              (typeofNames.has(left.value) || typeofNames.has(right.value)) &&
              (operation.operator === '===' || operation.operator === '!==')
            )
              truth = (leftText === rightText) === (operation.operator === '===')
          } else if (operation.form === 'unary' && operation.operator === '!' && left !== undefined) {
            const value = truthiness.get(left.value)
            if (value !== undefined) truth = !value
          }
        } else if (operation.kind === 'test' && undefinedValues.has(operation.value.value)) {
          switch (operation.predicate) {
            case 'to-boolean':
            case 'is-present':
            case 'is-defined':
              truth = false
          }
        }
        const result = resultOfIrOperation(operation)
        if (result === null) continue
        if (absent && !undefinedValues.has(result.id)) {
          undefinedValues.add(result.id)
          changed = true
        }
        if (undefinedValues.has(result.id)) truth = false
        if (truth !== undefined && !truthiness.has(result.id)) {
          truthiness.set(result.id, truth)
          changed = true
        }
      }
      if (
        returnedUndefined.has(body.sourceOwner) ||
        sourceBodies.get(body.sourceOwner)?.length !== 1 ||
        body.abi === null ||
        body.abi.result.kind === 'void' ||
        body.async ||
        body.generator ||
        body.generatorPrologueBoundary ||
        body.tryRegions.length > 0 ||
        body.iteratorCloseRegions?.length
      )
        continue
      const returns = [...dominance.reachable].flatMap((id) => {
        const terminator = body.blocks.get(id)?.terminator
        return terminator?.kind === 'return' ? [terminator] : []
      })
      if (
        returns.length > 0 &&
        returns.every(
          (operation) =>
            operation.value !== null &&
            undefinedValues.has(operation.value.value) &&
            preservesUndefined(operation.value.representation, body.abi!.result, input)
        )
      ) {
        returnedUndefined.add(body.sourceOwner)
        changed = true
      }
    }
  }
  return { undefinedValues, truthiness }
}
