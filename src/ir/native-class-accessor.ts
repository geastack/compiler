import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { conversionNodeIdOf } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import { classFamilyOverridesOf } from '../projection/dispatch.js'
import { representationKey } from '../representation/model.js'
import type { IrBody, IrOperation, IrOperand } from './model.js'

/** A direct native accessor is an ordinary body entry on the same receiver.
 * Overridden families and adapting frames remain with the dispatch census;
 * matching one implementation never authenticates the others.
 *
 * A setter argument may also reach its formal through the conversion the
 * emitter applies there (`emit-properties.ts` aligns the value to the
 * setter's parameter through the census node): only a node that is itself
 * certified as a payload-preserving, field-protocol-free native transfer
 * (`nativePayloadTransportMatches`) qualifies, so the formal holds the very
 * payload the store wrote. Without the census no conversion is admitted. */
export const nativeClassAccessorEntryOf = (
  operation: IrOperation,
  key: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): { readonly functionId: FunctionId; readonly arguments: readonly IrOperand[] } | null => {
  if ((operation.kind !== 'get' && operation.kind !== 'set') || key === null) return null
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref' || receiver.ownership !== 'shared-refcount') return null
  const layout = classes.get(receiver.declaration)
  if (!layout || layout.nativeBase !== null || classFamilyOverridesOf(classes, receiver.declaration, key).length > 0) return null
  const member = classMemberOf(classes, receiver.declaration, key)
  if (member?.kind !== 'accessor') return null
  const functionId = operation.kind === 'get' ? member.accessor.getter : member.accessor.setter
  const frame = functionId === null ? null : bodyOf(functionId)?.abi
  const owner = classes.get(member.owner)
  if (
    !functionId ||
    !frame ||
    !owner?.instance ||
    owner.nativeBase !== null ||
    frame.receiver === null ||
    representationKey(frame.receiver) !== representationKey(owner.instance) ||
    frame.restFrom !== null
  )
    return null
  if (operation.kind === 'get') {
    if (frame.parameters.length !== 0 || representationKey(frame.result) !== representationKey(operation.result.representation)) return null
    return { functionId, arguments: [] }
  }
  if (frame.result.kind !== 'void' || frame.parameters.length !== 1) return null
  const formal = frame.parameters[0]!.value
  const written = operation.value.representation
  if (
    representationKey(formal) !== representationKey(written) &&
    !nativePayloadTransportMatches(written, formal, conversions?.nodeById(conversionNodeIdOf(written, formal)))
  )
    return null
  return { functionId, arguments: [operation.value] }
}
