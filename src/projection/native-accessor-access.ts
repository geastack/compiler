import type { FunctionId } from '../identity/ids.js'
import type { CallableAbi, RecordAccessor, Representation } from '../representation/model.js'

/**
 * Whether a record accessor's bodies can answer the native (unboxed) field
 * protocol, and with which value carrier.
 *
 * The native read invokes the getter with only its receiver and hands the
 * caller a typed payload; the native write passes exactly one typed argument
 * to the setter. Both are properties of the bodies' projected frames, so they
 * are answered here, once, from `accessorAbiFor` -- the target spells the arm
 * and does not re-derive admissibility from the frame's shape.
 */
export interface NativeAccessorAccess {
  /** `null` when the getter cannot answer a native read. */
  readonly read: {
    /** The public value carrier the read produces. */
    readonly value: Representation
    /** The physical body returns nothing; the read still runs it for its effects and yields `undefined`. */
    readonly voidResult: boolean
  } | null
  /** `null` when the setter cannot accept a native write; otherwise the carrier its one argument takes. */
  readonly write: { readonly value: Representation } | null
}

export const nativeAccessorAccessOf = (
  accessor: RecordAccessor,
  accessorAbiFor: ((callable: FunctionId) => CallableAbi | null) | undefined
): NativeAccessorAccess => {
  const getter = accessor.getter === null ? null : (accessorAbiFor?.(accessor.getter) ?? null)
  const setter = accessor.setter === null ? null : (accessorAbiFor?.(accessor.setter) ?? null)
  // A void body still performs the getter's effects. Its public undefined
  // result is a value; the physical body result is not a payload carrier.
  const voidResult = getter?.result.kind === 'void'
  const readValue = voidResult ? accessor.value : getter?.result
  const read =
    getter !== null &&
    readValue !== undefined &&
    (!voidResult || readValue.kind === 'undefined') &&
    getter.parameters.length === 0 &&
    getter.restFrom === null
      ? { value: readValue, voidResult }
      : null
  const writeValue = setter?.parameters[0]?.value
  const write =
    setter !== null && writeValue !== undefined && setter.parameters.length === 1 && setter.restFrom === null ? { value: writeValue } : null
  return { read, write }
}
