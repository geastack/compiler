// `Object.assign(literal, options, extra)` returns its first argument.
//
// An extended-JSON serializer merges its defaults with the caller's optional
// options this way and hands the result on. The literal target is laid out by
// the same answer the call's result reads (`objectAssignTargetType`); resolved
// against its contextual `T` instead, it minted a second record of the same
// members and the copy refused to return it. A member only the later source
// adds lives in the target's sidecar, and a view that requires it reads it
// from there rather than starting it value-initialized.
//
// Not covered here: that serializer's own `seenObjects: [{ propertyName, obj: null }]`
// viewed as `{ propertyName; obj: unknown }[]` needs a dynamic -> owned-record
// array conversion `DynamicCarrier` does not have; it aborts by name.

type OptionsBase = {
  legacy?: boolean
  relaxed?: boolean
}
type SerializeOptions = OptionsBase & {
  ignoreUndefined?: boolean
}

function serialize(value: number, options: { relaxed: boolean; legacy: boolean; depth: number }): string {
  return `${value} ${options.relaxed} ${options.legacy} ${options.depth}`
}

function stringify(value: number, options?: SerializeOptions): string {
  const serializeOptions = Object.assign({ relaxed: true, legacy: false }, options, { depth: 1 })
  return serialize(value, serializeOptions)
}

//! expect: defaults=1 true false 1
console.log(`defaults=${stringify(1)}`)
//! expect: legacy=2 true true 1
console.log(`legacy=${stringify(2, { legacy: true })}`)
