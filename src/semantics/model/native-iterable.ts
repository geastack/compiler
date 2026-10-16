import type { DeclarationId, SemanticResultId, StructuralTypeId } from '../../identity/ids.js'

/** Target-neutral transport of a closed source native iteration proof.
 * Factory templates remain in installed host metadata, never in semantics.
 */
export interface NativeIterableReceipt {
  readonly protocol: 'host-sync-iterable@1'
  readonly receiverNative: string
  readonly method: DeclarationId
  readonly source: SemanticResultId
  readonly iterator: StructuralTypeId
  readonly element: StructuralTypeId
  readonly returnMethod: 'absent'
}

export const nativeIterableReceiptsEqual = (left: NativeIterableReceipt, right: NativeIterableReceipt): boolean =>
  left.protocol === right.protocol &&
  left.receiverNative === right.receiverNative &&
  left.method === right.method &&
  left.source === right.source &&
  left.iterator === right.iterator &&
  left.element === right.element &&
  left.returnMethod === right.returnMethod
