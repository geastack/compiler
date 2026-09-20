//! dynamic-fallback
//! expect: left:2
//! expect: right:3
// `left` and `right` share one calling convention -- `(value: number):
// string` -- so `Choice = typeof left | typeof right` derives to ONE
// `function-value-dispatch` carrier rather than a tagged union of two
// distinct callable declarations (`sharedAbiOf`, representation/derive.ts):
// there is no per-arm identity to distinguish at the boundary, only one ABI
// to recover. `callableDeclarationIdentity()` is the mechanism for
// disambiguating a union whose arms genuinely differ, which this pin assumed
// without it; the actual, correct recovery here is the plain generic
// dynamic-callable adapter over that single shared ABI.
//! emitted-has: DynamicCarrier<gea::CallableObject<std::string(double)>>::in(

function left(value: number): string {
  return `left:${value}`
}
namespace left {
  export const family = 'left' as const
}

function right(value: number): string {
  return `right:${value}`
}
namespace right {
  export const family = 'right' as const
}

type Choice = typeof left | typeof right

function recover(value: any): Choice {
  return value
}

console.log(recover(left)(2))
console.log(recover(right)(3))
