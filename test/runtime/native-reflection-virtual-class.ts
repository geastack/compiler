class NativeBase {
  value = 5
  read(index: number): number {
    return this.value + index
  }
}
class NativeDerived extends NativeBase {
  read(index: number): number {
    return this.value + index + 10
  }
}
function readNative(value: NativeBase): number {
  return value.read(2)
}
function narrowNative(value: NativeBase | null | undefined): number {
  if (value instanceof NativeDerived) return value.value
  return 0
}
//! expect: 17
console.log(readNative(new NativeDerived()))
//! expect: 7
console.log(readNative(new NativeBase()))
//! expect: 5
console.log(narrowNative(new NativeDerived()))
//! expect: 0
console.log(narrowNative(null))
