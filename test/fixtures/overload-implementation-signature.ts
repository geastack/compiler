// A NON-generic overload set with an implementation in source: the one
// runtime function is the implementation, and its signature is the value.
export function pad(value: string): string
export function pad(value: string, width: number): string
export function pad(value: string, width?: number): string {
  const target = width ?? 4
  let out = value
  while (out.length < target) out = ` ${out}`
  return out
}
const padder = pad
console.log(pad('a'), pad('b', 2), padder('c', 3))
