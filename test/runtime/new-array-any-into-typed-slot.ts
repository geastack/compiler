// `new Array(n)` is declared `any[]` by the standard library, so its allocation
// carries `array-object(dynamic)` while the slot it initializes is a lazily
// filled `number[] | null`. hono's trie router writes exactly this shape
// (router/trie-router/node.ts's `partOffsets`), and the certificate refused the
// store because no conversion rebuilds a dynamic-element array into a numeric one.

function totalOffsets(parts: string[]): number {
  const count = parts.length
  let partOffsets: number[] | null = null
  let total = 0
  for (let i = 0; i < count; i++) {
    if (partOffsets === null) {
      partOffsets = new Array(count)
      let offset = 0
      for (let p = 0; p < count; p++) {
        partOffsets[p] = offset
        offset += parts[p]!.length + 1
      }
    }
    total += partOffsets[i]!
  }
  return total
}

console.log(totalOffsets(['a', 'bb', 'ccc']))
//! expect: 7
