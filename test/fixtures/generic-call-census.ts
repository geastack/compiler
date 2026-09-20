const typedArrayName = (() => {
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
  return (value: unknown) => getter.call(value)
})()

function readName(value: unknown) {
  return typedArrayName(value)
}

declare function genericResult<T>(value: T): T
declare const alternate: <T>(value: T) => T
const concrete = genericResult('resolved')

console.log(readName(new Uint8Array([1])))
