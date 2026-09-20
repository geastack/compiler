//! expect: copied:alpha,beta
//! emitted-has: requireIterablePresent
//! emitted-has: appendRange

function copy(source: readonly string[] | undefined): string[] {
  // @ts-expect-error ArrayAccumulation reaches GetIterator and throws when the source is absent.
  return [...source]
}

console.log(`copied:${copy(['alpha', 'beta']).join(',')}`)
