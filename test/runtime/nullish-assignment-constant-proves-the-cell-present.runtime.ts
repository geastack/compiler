//! expect: 8 4 5 0
//! emitted-lacks: presentOrThrow

// A binary-document parser's `parseToElements(bytes, startOffset: number | null = 0)` opens with
// `startOffset ??= 0`. The fallback `0` is minted straight into the cell's
// `number | null` carrier, so no `convert` from a bare number stands between
// the literal and the write -- and every later read of `startOffset` was
// still presence-checked, once per loop iteration. A literal is exactly the
// value it spells: past the `??=`, the cell is present on both paths.
export function scan(bytes: Uint8Array, startOffset: number | null = 0): number {
  startOffset ??= 0
  let total = 0
  for (let i = startOffset; i < bytes.length; i++) total += (bytes[i] ?? 0) + startOffset
  return total + startOffset
}

console.log(scan(new Uint8Array([1, 2, 3]), 1), scan(new Uint8Array([4]), null), scan(new Uint8Array([5])), scan(new Uint8Array([]), 0))
