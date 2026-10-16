import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import type { NativeIterableProvider } from '../plugins/native-iterable-providers.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { nativeIterableReceiptsEqual, type NativeIterableReceipt } from '../semantics/model/native-iterable.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { GetIteratorOperation, IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

export interface NativeIterableCertificationInput {
  /** Independently retained source proofs, not reconstructed from IR receipts. */
  readonly nativeIterableAuthorities?: ReadonlyMap<SemanticResultId, NativeIterableReceipt> | undefined
  readonly nativeIterableProviders?: ReadonlyMap<string, NativeIterableProvider> | undefined
  readonly deriver: Pick<RepresentationDeriver, 'derive'>
  readonly definitionOf: (value: IrValueId) => IrOperation | null
}

/** First domain admits typed leaves; compound element protocols need their own
 * recursive provenance receipt. Physical keys intentionally erase native names.
 */
const elementMatches = (left: Representation, right: Representation): boolean => {
  if (left.kind === 'native-handle' || right.kind === 'native-handle')
    return (
      left.kind === 'native-handle' &&
      right.kind === 'native-handle' &&
      left.native !== null &&
      left.native === right.native &&
      representationKey(left) === representationKey(right)
    )
  if (left.kind !== 'scalar' && left.kind !== 'string' && left.kind !== 'undefined' && left.kind !== 'null') return false
  return representationKey(left) === representationKey(right)
}

/** An installed factory does not authorize a different operand or iterator ABI.
 * No authority inventory is installed yet: source admission remains disabled.
 */
export const nativeIterableReceiptMatches = (
  operation: GetIteratorOperation,
  semantic: SemanticOperation | null,
  input: NativeIterableCertificationInput
): boolean => {
  const stated = semantic?.family === 'protocol' ? semantic.nativeIterable : undefined
  const receipt = operation.nativeIterable
  const authority = input.nativeIterableAuthorities?.get(operation.lineage)
  if (!receipt && !stated) return authority === undefined
  if (!receipt || !stated || !nativeIterableReceiptsEqual(receipt, stated)) return false
  if (semantic?.family !== 'protocol' || semantic.protocol !== 'iterator' || semantic.step !== 'get-iterator') return false
  if (operation.protocol !== 'iterator' || operation.method !== null) return false
  if (!authority || !nativeIterableReceiptsEqual(receipt, authority)) return false
  const provider = input.nativeIterableProviders?.get(receipt.receiverNative)
  if (!provider || provider.protocol !== receipt.protocol || provider.receiverNative !== receipt.receiverNative) return false
  if (receipt.protocol !== 'host-sync-iterable@1' || receipt.returnMethod !== 'absent') return false
  const target = semantic.operands.find((operand) => operand.role === 'target' && operand.ordinal === 0)
  const result = semantic.results.find((result) => result.role === 'iterator-record')
  if (!target || target.source.kind !== 'result' || target.source.result !== receipt.source || result?.type !== receipt.iterator)
    return false
  const definition = input.definitionOf(operation.receiver.value)
  if (!definition || definition.lineage !== receipt.source || resultOfIrOperation(definition)?.id !== operation.receiver.value) return false
  const source = input.deriver.derive(target.type)
  const receiver = operation.receiver.representation
  if (
    source.kind !== 'native-handle' ||
    source.native !== receipt.receiverNative ||
    receiver.kind !== 'native-handle' ||
    receiver.native !== receipt.receiverNative
  )
    return false
  if (representationKey(source) !== representationKey(receiver)) return false
  const iterator = input.deriver.derive(receipt.iterator)
  const element = input.deriver.derive(receipt.element)
  if (iterator.kind !== 'iterator' || iterator.source !== 'sequence') return false
  if (element.kind === 'dynamic' || element.kind === 'unresolved') return false
  if (!elementMatches(iterator.element, element)) return false
  const actual = operation.result.representation
  if (actual.kind !== 'iterator' || actual.source !== 'sequence') return false
  if (iterator.resume.kind !== 'undefined' || iterator.completion.kind !== 'undefined') return false
  if (actual.resume.kind !== 'undefined' || actual.completion.kind !== 'undefined') return false
  return elementMatches(actual.element, element)
}
