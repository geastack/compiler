import type { IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { HostMemberTable } from '../targets/cpp/host/host-members.js'
import { authenticatedNativeHostMethodReadOf, type AuthenticatedNativeHostMethodRead } from './intrinsic-call-facts.js'
import { allOperationsOf, type GetOperation, type IrBody, type IrOperation } from './model.js'
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
 */
export const publishNativeHostMethodReads = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  rendering: CalleeRenderingInput | undefined,
  hosts?: HostMemberTable
): ReadonlyMap<PhysicalBodyId, IrBody> =>
  new Map(
    [...bodies].map(([id, body]) => {
      const proofs = nativeHostMethodReadProofsOf(body, rendering, hosts)
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((operation) => {
                  if (operation.kind !== 'get') return operation
                  const { nativeHostMethodRead: _previous, ...current } = operation
                  const proof = proofs.get(operation)
                  return proof === undefined ? current : { ...current, nativeHostMethodRead: proof.receipt }
                })
              }
            ])
          )
        }
      ]
    })
  )
