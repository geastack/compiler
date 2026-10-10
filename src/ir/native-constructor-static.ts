import type { ConversionCensus } from '../conversion/nodes.js'
import { conversionNodeIdOf } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classStaticMemberOf } from '../projection/fields.js'
import { representationKey, type Representation } from '../representation/model.js'
import { staticFieldStorageAlongOf, type ClassStaticFieldSlots } from './class-static-fields.js'
import type { IrBody, IrOperand, IrOperation } from './model.js'

const nativeTransfer = (source: Representation, target: Representation, conversions?: Pick<ConversionCensus, 'nodeById'>): boolean =>
  representationKey(source) === representationKey(target) ||
  nativePayloadTransportMatches(source, target, conversions?.nodeById(conversionNodeIdOf(source, target)))

/** A compiler-owned constructor cell is selected by the same inherited storage walk as emitted Get/Set. */
export const nativeConstructorStaticCellOf = (
  operation: IrOperation,
  key: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  slots: ClassStaticFieldSlots,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): { readonly owner: DeclarationId; readonly key: string; readonly representation: Representation } | null => {
  if ((operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'define-own-property') || key === null) return null
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'constructor-family' || receiver.members.length === 0) return null
  if (receiver.members.some((id) => classes.get(id)?.nativeBase !== null)) return null
  const slot = staticFieldStorageAlongOf(classes, receiver.members, key, (owner, key) => slots.slots.get(owner)?.get(key) ?? null)
  if (slot === null || slots.conflicts.includes(`${slot.owner}.${key}`)) return null
  const site = classStaticMemberOf(classes, receiver.members[0]!, key)
  if (site !== null && site.kind !== 'field') return null
  const target = operation.kind === 'get' ? operation.result.representation : slot.value
  const source = operation.kind === 'get' ? slot.value : operation.value.representation
  return nativeTransfer(source, target, conversions) ? { owner: slot.owner, key, representation: slot.value } : null
}

/** Only a selected, present physical static accessor body supplies its normal result origins. */
export const nativeConstructorAccessorEntryOf = (
  operation: IrOperation,
  key: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): { readonly functionId: FunctionId; readonly arguments: readonly IrOperand[]; readonly receiver: IrOperand | null } | null => {
  if ((operation.kind !== 'get' && operation.kind !== 'set') || key === null) return null
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'constructor-family' || receiver.members.length !== 1 || classes.get(receiver.members[0]!)?.nativeBase !== null)
    return null
  const site = classStaticMemberOf(classes, receiver.members[0]!, key)
  if (site?.kind !== 'accessor') return null
  const functionId = operation.kind === 'get' ? site.accessor.getter : site.accessor.setter
  const body = functionId === null ? null : bodyOf(functionId)
  const frame = body?.abi
  if (
    functionId === null ||
    !body ||
    body.sourceOwner !== functionId ||
    !body.blocks.has(body.entry) ||
    body.async ||
    body.generator ||
    body.construct !== null ||
    !frame ||
    frame.restFrom !== null ||
    (frame.receiver !== null && representationKey(frame.receiver) !== representationKey(receiver))
  )
    return null
  if (operation.kind === 'get') {
    if (frame.parameters.length !== 0 || !nativeTransfer(frame.result, operation.result.representation, conversions)) return null
    return { functionId, arguments: [], receiver: frame.receiver === null ? null : operation.receiver }
  }
  if (
    frame.result.kind !== 'void' ||
    frame.parameters.length !== 1 ||
    !nativeTransfer(operation.value.representation, frame.parameters[0]!.value, conversions)
  )
    return null
  return { functionId, arguments: [operation.value], receiver: frame.receiver === null ? null : operation.receiver }
}
