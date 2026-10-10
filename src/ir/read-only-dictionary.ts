import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import { operationOfResult } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import type { Representation } from '../representation/model.js'
import { closedCallFrameOf, hostTemplateFrameOf } from './call-entry.js'
import { authenticatedArrayIsArrayCall } from './intrinsic-call-facts.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import { allOperationsOf, type IrBlockId, type IrBody, type IrOperation } from './model.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'

interface Consumer {
  readonly body: PhysicalBodyId
  readonly block: IrBlockId
  readonly ordinal: number
  readonly lineage: SemanticResultId | null
  readonly kind: IrOperation['kind']
}

/**
 * Every use of this evaluated view stays inside a closed read frame.
 * @semanticCategory generic-primitive
 */
export interface ReadOnlyDictionaryProof {
  readonly root: IrValueId
  readonly aliases: readonly IrValueId[]
  readonly consumers: readonly Consumer[]
}

export interface ReadOnlyDictionaryInputs {
  readonly calleeRendering?: CalleeRenderingInput
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly conversions: Pick<ConversionCensus, 'nodeById'>
}

const holdsDictionary = (value: Representation): boolean => {
  switch (value.kind) {
    case 'dictionary':
      return true
    case 'optional':
      return holdsDictionary(value.payload)
    case 'borrowed-ref':
      return holdsDictionary(value.referent)
    case 'tagged-union':
      return value.arms.some((arm) => holdsDictionary(arm.value))
    default:
      return false
  }
}

interface Use extends Consumer {
  readonly operation: IrOperation
  readonly owner: IrBody
}

/**
 * Index the final executable program once; publication and certification each build their own index.
 * @semanticCategory generic-primitive
 */
export const createReadOnlyDictionaryAuthority = (input: ReadOnlyDictionaryInputs) => {
  const uses = new Map<IrValueId, Use[]>()
  const definitions = new Map<IrValueId, IrOperation>()
  const representations = new Map<IrValueId, Representation>()
  const cellReads = new Map<DeclarationId, { readonly value: IrValueId; readonly owner: IrBody['sourceOwner'] }[]>()
  const capturedCells = new Set<DeclarationId>()
  const bodiesOfFunction = new Map<FunctionId, IrBody[]>()
  const parameters = new Map<IrBody, ReadonlyMap<number, IrValueId>>()
  const observed = new Set<IrValueId>()
  for (const body of input.bodies.values()) {
    for (const declaration of body.facts?.capturedDeclarations ?? []) capturedCells.add(declaration)
    const source = body.sourceOwner as FunctionId
    const implementations = bodiesOfFunction.get(source) ?? []
    implementations.push(body)
    bodiesOfFunction.set(source, implementations)
    const formals = new Map<number, IrValueId>()
    for (const block of body.blocks.values())
      for (const [ordinal, operation] of [...allOperationsOf(block)].entries()) {
        const use: Use = {
          body: body.owner,
          block: block.id,
          ordinal,
          lineage: operation.lineage,
          kind: operation.kind,
          operation,
          owner: body
        }
        for (const operand of operandsOfIrOperation(operation)) {
          const list = uses.get(operand.value) ?? []
          if (!list.some((known) => known.operation === operation)) list.push(use)
          uses.set(operand.value, list)
          observed.add(operand.value)
        }
        const result = resultOfIrOperation(operation)
        if (result !== null) {
          definitions.set(result.id, operation)
          representations.set(result.id, result.representation)
        }
        if (operation.kind === 'parameter') formals.set(operation.ordinal, operation.result.id)
        if (operation.kind === 'binding-read') {
          const list = cellReads.get(operation.declaration) ?? []
          list.push({ value: operation.result.id, owner: body.sourceOwner })
          cellReads.set(operation.declaration, list)
        }
      }
    parameters.set(body, formals)
  }

  const bodyOf = (id: FunctionId): IrBody | null => {
    const bodies = bodiesOfFunction.get(id)
    const body = bodies?.length === 1 ? bodies[0] : null
    return body && !body.async && !body.generator && !body.generatorPrologueBoundary ? body : null
  }

  const formal = (id: FunctionId, ordinal: number): IrValueId | null => {
    const body = bodyOf(id)
    return body === null ? null : (parameters.get(body)?.get(ordinal) ?? null)
  }

  const proofOf = (root: IrValueId): ReadOnlyDictionaryProof | null => {
    const representation = representations.get(root)
    if (representation === undefined || !holdsDictionary(representation)) return null
    const aliases = new Set<IrValueId>()
    const consumers = new Map<string, Consumer>()
    const pending = [root]
    const cursors = new Set<IrValueId>()
    const retain = (value: IrValueId): boolean => {
      const carrier = representations.get(value)
      if (carrier === undefined || carrier.kind === 'dynamic') return false
      if (holdsDictionary(carrier) || cursors.has(value)) pending.push(value)
      return true
    }
    while (pending.length) {
      const value = pending.pop()!
      if (aliases.has(value)) continue
      aliases.add(value)
      for (const use of uses.get(value) ?? []) {
        const operation = use.operation
        consumers.set(`${use.body}:${use.block}:${use.ordinal}`, {
          body: use.body,
          block: use.block,
          ordinal: use.ordinal,
          lineage: use.lineage,
          kind: use.kind
        })
        if (cursors.has(value)) {
          if (
            (operation.kind === 'iterator-next' && operation.iterator.value === value && operation.value?.value !== value) ||
            ((operation.kind === 'iterator-done' || operation.kind === 'iterator-close') && operation.iterator.value === value)
          )
            continue
          return null
        }
        switch (operation.kind) {
          case 'phi':
            if (!retain(operation.result.id)) return null
            break
          case 'binding-write': {
            const storage = input.placements.get(operation.declaration)?.storage
            if (
              operation.value.value !== value ||
              (storage?.kind !== 'local' && storage?.kind !== 'region') ||
              storage.owner !== use.owner.sourceOwner ||
              capturedCells.has(operation.declaration)
            )
              return null
            for (const read of cellReads.get(operation.declaration) ?? [])
              if (read.owner !== use.owner.sourceOwner || !retain(read.value)) return null
            break
          }
          case 'convert': {
            if (operation.source.value !== value || operation.rebuild !== undefined) return null
            const node = input.conversions.nodeById(operation.conversionUse)
            if (node === null || node.capability.kind === 'never' || operation.result.representation.kind === 'dynamic') return null
            // A native tag/absence projection may discard the dictionary arm.
            // It cannot expose the readonly handle through a foreign carrier.
            if (!holdsDictionary(operation.result.representation)) {
              if (
                node.capability.kind !== 'identity' &&
                (!('materializer' in node.capability) ||
                  node.capability.materializer.nativeFieldProtocol !== 'unused' ||
                  node.capability.materializer.nativePayloadTransport !== 'preserved')
              )
                return null
            } else if (!retain(operation.result.id)) return null
            break
          }
          case 'merge-live-arm-rebuild':
            if (operation.source.value !== value || operation.nativeTransport === undefined || !retain(operation.result.id)) return null
            break
          case 'get':
            if (operation.receiver.value !== value || operation.key.value === value || !retain(operation.result.id)) return null
            break
          case 'has-property':
            if (operation.receiver.value !== value || operation.key.value === value) return null
            break
          case 'own-property-keys':
            if (operation.receiver.value !== value) return null
            break
          case 'get-iterator':
            if (operation.receiver.value !== value || operation.protocol !== 'enumerate' || operation.method !== null) return null
            cursors.add(operation.result.id)
            pending.push(operation.result.id)
            break
          case 'spread-copy':
            if (operation.source.value !== value || operation.receiver.value === value) return null
            break
          case 'test':
          case 'branch':
            break
          case 'compute':
            if (!observesNativeCarrierOnly(operation)) return null
            if (
              operation.form === 'require-object-coercible' ||
              operation.form === 'require-iterable-present' ||
              operation.form === 'require-tagged-union-arm'
            )
              if (!retain(operation.result.id)) return null
            break
          case 'call': {
            if (
              operation.callee.value === value ||
              operation.receiver?.value === value ||
              operation.thisArgument?.value === value ||
              operation.argumentsAreSpread
            )
              return null
            const rendering = input.calleeRendering
            const semantic =
              operation.lineage === null || rendering === undefined
                ? null
                : (rendering.graph.operations.get(operationOfResult(operation.lineage)) ?? null)
            if (
              operation.hostTemplate === 'array-is-array' &&
              authenticatedArrayIsArrayCall(operation, semantic, rendering, (id) => definitions.get(id) ?? null) &&
              hostTemplateFrameOf(operation, input.conversions, null, input.classes) === true
            )
              break
            const identity = operation.closedCallee
            if (identity?.kind !== 'exact' || identity.nativeEntryAbi !== undefined) return null
            // A rest frame puts the handle inside an array. Its element aliases
            // need their own proof before this authority can follow that frame.
            if (bodyOf(identity.functionId)?.abi?.restFrom !== null) return null
            const producer = definitions.get(operation.callee.value)
            const actual =
              producer?.kind === 'allocate-callable'
                ? producer.functionId
                : producer?.kind === 'binding-read' || producer?.kind === 'get'
                  ? producer.closedCallable?.kind === 'exact'
                    ? producer.closedCallable.functionId
                    : null
                  : null
            if (
              actual !== identity.functionId ||
              closedCallFrameOf(operation, identity, (id) => bodyOf(id)?.abi ?? null, observed, input.conversions) === undefined
            )
              return null
            for (const [ordinal, argument] of operation.arguments.entries()) {
              if (argument.value !== value) continue
              const target = formal(identity.functionId, ordinal)
              if (target === null || !retain(target)) return null
            }
            break
          }
          case 'construct': {
            if (operation.callee.value === value || operation.newTarget.value === value) return null
            const branches = nativeClassConstructionOf(operation, input.classes, bodyOf, input.conversions)
            if (branches === null) return null
            for (const branch of branches)
              for (const entry of branch.entries)
                for (const [ordinal, argument] of entry.arguments.entries()) {
                  if (argument.value !== value) continue
                  const target = formal(entry.functionId, ordinal)
                  if (target === null || !retain(target)) return null
                }
            break
          }
          default:
            return null
        }
      }
    }
    return {
      root,
      aliases: [...aliases].sort(),
      consumers: [...consumers.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, use]) => use)
    }
  }

  const matches = (root: IrValueId, proof: ReadOnlyDictionaryProof | undefined): boolean => {
    const expected = proofOf(root)
    return (
      proof !== undefined &&
      expected !== null &&
      proof.root === expected.root &&
      proof.aliases.length === expected.aliases.length &&
      proof.aliases.every((alias, index) => alias === expected.aliases[index]) &&
      proof.consumers.length === expected.consumers.length &&
      proof.consumers.every((use, index) => {
        const actual = expected.consumers[index]!
        return (
          use.body === actual.body &&
          use.block === actual.block &&
          use.ordinal === actual.ordinal &&
          use.lineage === actual.lineage &&
          use.kind === actual.kind
        )
      })
    )
  }
  return { proofOf, matches }
}
