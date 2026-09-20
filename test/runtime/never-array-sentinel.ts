//! expect: true true 0 true 1
//! emitted-has: emptyArraySentinel
// tsc's `emptyArray: never[]` is compared by IDENTITY (`resolvedBaseTypes =
// emptyArray` marks a circular resolution in progress; `=== emptyArray`
// detects it). A `never[]` converts into `E[]` as the ONE empty array of `E`,
// so every read of the sentinel through the same element type is the same
// object; a `[]` literal in a merge arm stays a fresh array, as in JS.
export const emptyArray: never[] = [] as never[]
interface Item {
  id: number
}
interface Holder {
  resolved: Item[] | undefined
}
function resolveBase(holder: Holder): Item[] {
  if (holder.resolved === emptyArray) return emptyArray
  holder.resolved = emptyArray
  return holder.resolved
}
const holder: Holder = { resolved: undefined }
const first = resolveBase(holder)
const cached: Item[] = emptyArray
const names: string[] = emptyArray
const boxed: any[] = emptyArray
console.log(first === emptyArray, cached === emptyArray, names.length, holder.resolved === emptyArray, boxed.length + 1)
