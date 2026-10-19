import type { IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { HostMemberTable } from '../targets/cpp/host/host-members.js'
import { authenticatedNativeHostMethodReadOf, type AuthenticatedNativeHostMethodRead } from './intrinsic-call-facts.js'
import {
  allOperationsOf,
  type GetOperation,
  type IrBlock,
  type IrBlockId,
  type IrBody,
  type IrNonTerminatorOperation,
  type IrOperation
} from './model.js'
import { resultOfIrOperation } from './queries.js'

/** Final call entries authenticate the exact deferred reads, independently
 * of any previously published receipt on those Get operations.
 */
export const nativeHostMethodReadProofsOf = (
  body: IrBody,
  rendering: CalleeRenderingInput | undefined,
  hosts?: HostMemberTable
): ReadonlyMap<GetOperation, AuthenticatedNativeHostMethodRead> => {
  const reads = new Map<GetOperation, AuthenticatedNativeHostMethodRead>()
  if (rendering === undefined) return reads
  const operations = [...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)])
  const definitions = new Map<IrValueId, IrOperation>()
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result !== null) definitions.set(result.id, operation)
  }
  for (const operation of operations) {
    if (operation.kind !== 'call') continue
    const semanticId = rendering.graph.results.get(operation.lineage)
    const semantic = semanticId === undefined ? null : (rendering.graph.operations.get(semanticId) ?? null)
    const proof = authenticatedNativeHostMethodReadOf(
      operation,
      semantic,
      rendering,
      (value) => definitions.get(value) ?? null,
      hosts,
      operation.hostTemplate
    )
    if (proof !== null) reads.set(proof.read, proof)
  }
  return reads
}

/** Publish before callable, field-presence or reflection flow first runs;
 * every subsequent rewrite recomputes rather than inherits this receipt.
 *
 * A Get that carries no receipt and earns none is kept as it is, and so is a
 * block or body with nothing republished: a whole fresh copy of the program
 * beside the input, which every caller still holds, sat under the callable
 * flow solved over it.
 */
export const publishNativeHostMethodReads = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  rendering: CalleeRenderingInput | undefined,
  hosts?: HostMemberTable
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const result = new Map<PhysicalBodyId, IrBody>()
  for (const [id, body] of bodies) {
    const proofs = nativeHostMethodReadProofsOf(body, rendering, hosts)
    let blocks: Map<IrBlockId, IrBlock> | null = null
    for (const [blockId, block] of body.blocks) {
      let operations: IrNonTerminatorOperation[] | null = null
      for (let at = 0; at < block.operations.length; at++) {
        const operation = block.operations[at]!
        if (operation.kind !== 'get') continue
        const proof = proofs.get(operation)
        if (proof === undefined && !Object.prototype.hasOwnProperty.call(operation, 'nativeHostMethodRead')) continue
        const { nativeHostMethodRead: _previous, ...current } = operation
        ;(operations ??= block.operations.slice())[at] = proof === undefined ? current : { ...current, nativeHostMethodRead: proof.receipt }
      }
      if (operations === null) continue
      blocks ??= new Map(body.blocks)
      blocks.set(blockId, { ...block, operations })
    }
    result.set(id, blocks === null ? body : { ...body, blocks })
  }
  return result
}
