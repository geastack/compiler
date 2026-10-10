import type { SignatureShape } from '../semantics/model/structural-types.js'
import type { CallableAbi, Representation } from './model.js'

/** A structural native object can authenticate the logical receiver at its source entry. */
export const isStructuralMethodReceiver = (receiver: Representation | null): boolean =>
  receiver !== null &&
  'ownership' in receiver &&
  receiver.ownership === 'shared-refcount' &&
  (receiver.kind === 'record' ||
    receiver.kind === 'record-with-index' ||
    (receiver.kind === 'native-record-ref' && receiver.native === null))

/** Only implicit structural methods expose a receiverless Function value. Explicit this remains part of the public frame. */
export const publicStructuralMethodAbiOf = (signatures: readonly SignatureShape[], physical: CallableAbi): CallableAbi =>
  signatures.length > 0 &&
  signatures.every((signature) => signature.implicitReceiver === true) &&
  isStructuralMethodReceiver(physical.receiver)
    ? { ...physical, receiver: null }
    : physical
