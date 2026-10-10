// A binary-document serializer's `isUint8Array`: a host accessor read off a property descriptor
// (`TypedArray.prototype[Symbol.toStringTag]`'s getter) captured into a
// binding and invoked through `Function.prototype.call`. The receiver's own
// physical convention is known at the call, so `g.call(value)` is a direct
// call of `g` with `value` as its this-value -- not a read of `.call`
// producing a callable in `.call`'s OWN generic frame that the receiver then
// has to be adapted into, one heap adapter per call.
//! emitted-lacks: adaptSource
const tagOf = (() => {
  const g = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
  return (value: unknown) => g.call(value)
})()
console.log(tagOf(new Uint8Array(2)), tagOf(new Float64Array(1)), tagOf([]), tagOf(3))
//! expect: Uint8Array Float64Array undefined undefined
export {}
