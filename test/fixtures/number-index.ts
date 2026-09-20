// A record shape carried entirely by a number-keyed index signature -- the
// `dictionary` carrier's number-keyed sibling of `declared-dictionary.ts`'s
// string-keyed `StringCounts`. No named members: the shape is carried
// directly by its own index signature, and `derive.ts`'s `dictionaryIndexOf`
// must read the key domain off the shape rather than assuming `'string'`.
export interface Sparse {
  [index: number]: string
}

export function identity(sparse: Sparse): Sparse {
  return sparse
}

// A record whose named members sit alongside a number-keyed index signature --
// the `record-with-index` carrier's number-keyed sibling of `interface Style
// { width?: number; [key: string]: unknown }`. The named half (`count`) is an
// ordinary struct field with a fixed offset; the index signature is the open
// half, carried by a `gea::NumericDictionary<V>` sidecar member
// (`targets/cpp/records.ts`) instead of the string-keyed `gea::Dictionary<V>`.
export interface Mixed {
  count: number
  [index: number]: string
}

export function total(mixed: Mixed): number {
  return mixed.count
}

// A top-level statement, so the module body this file compiles to has real
// work to lower -- every construct above this line is a declaration only.
export const marker: number = 0

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const sparse = identity({ 0: 'zero' })
export const probe = total({ count: 1, 0: 'zero' })
