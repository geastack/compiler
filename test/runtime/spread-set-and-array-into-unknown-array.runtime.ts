// A `Set<string>` AND A `string[]` SPREAD INTO AN ARRAY RETURNED AS `unknown`.
//
// A database client's `compressors` option transform (its URI parser) builds
// `const compressionList = new Set()`, adds `String(c)` for each valid name,
// and returns `[...compressionList]` from a `transform(...): unknown`. Spread
// is ArrayAccumulation over the Set's insertion order: duplicates were
// already dropped by the Set, and each element lands as itself.

const known = ['none', 'brotli', 'zlib', 'gzip']

function compressors(values: (string[] | string)[]): unknown {
  const compressionList = new Set()
  for (const compVal of values) {
    const compValArray = typeof compVal === 'string' ? compVal.split(',') : compVal
    for (const c of compValArray) {
      if (known.includes(String(c))) {
        compressionList.add(String(c))
      } else {
        throw new Error(`${c} is not a valid compression mechanism`)
      }
    }
  }
  return [...compressionList]
}

function names(values: string[]): unknown {
  return [...values]
}

//! expect: list=["zlib","brotli","gzip"]
console.log(`list=${JSON.stringify(compressors(['zlib,brotli', ['gzip', 'zlib']]))}`)
//! expect: copied=["a","b"]
console.log(`copied=${JSON.stringify(names(['a', 'b']))}`)
//! expect: refused=lz4 is not a valid compression mechanism
try {
  compressors(['lz4'])
} catch (error) {
  console.log(`refused=${(error as Error).message}`)
}
