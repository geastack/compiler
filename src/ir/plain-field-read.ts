import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf, recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { borrowSafeOperationsOf, type PlainFieldRead } from './borrow-effects.js'
import type { GetOperation, IrBody } from './model.js'
import { nativeData } from './write-effects.js'

/**
 * Whether reading `key` off a value carried as `receiver` loads a data field:
 * no getter of the program's can answer it.
 *
 * One answer for the whole compilation, asked by the IR's own dense-loop plan
 * as well as by the target, because both have to agree on which loops change
 * no array: the IR plan places a window's setup where its hoists put the bound,
 * and the target renders the setup there.
 */
export const plainFieldReadOf =
  (classes: ReadonlyMap<DeclarationId, ClassLayout>, deriver: RepresentationDeriver): PlainFieldRead =>
  (receiver, key) => {
    if (receiver.kind === 'class-ref') {
      // A class over a host base reads its members through the host's
      // protocol; only a wholly projected class has plain member loads.
      if (classes.get(receiver.declaration)?.nativeBase !== null) return false
      return classMemberOf(classes, receiver.declaration, key)?.kind === 'field'
    }
    if (receiver.kind === 'record')
      return receiver.fields.some((field) => field.key === key) && !receiver.accessors.some((accessor) => accessor.key === key)
    // An interface-typed record is the same struct, its members named by its shape.
    if (receiver.kind === 'native-record-ref' && receiver.native === null)
      return (
        (recordFieldsOfShape(deriver, receiver.shapeId)?.some((field) => field.key === key) ?? false) &&
        !(recordAccessorsOfShape(deriver, receiver.shapeId)?.some((accessor) => accessor.key === key) ?? true)
      )
    return false
  }

/**
 * The property reads of a body that run none of the program's code: a data
 * field (`plainFieldRead`, through borrow-effects' safe reads), a read of
 * native data -- an array element or length, a string, a host handle -- or a
 * host method. A getter is a property read too, and it can push onto the array
 * a loop walks; `ir/hoist.ts` asks this before treating a read as touching no
 * array.
 */
export const codeFreeGetOf = (body: IrBody, plainFieldRead: PlainFieldRead): ((operation: GetOperation) => boolean) => {
  let safe: ReturnType<typeof borrowSafeOperationsOf> | null = null
  return (operation) => {
    if (operation.hostMethod !== undefined || nativeData(operation.receiver.representation)) return true
    safe ??= borrowSafeOperationsOf(body, new Set(), plainFieldRead)
    return safe.has(operation)
  }
}
