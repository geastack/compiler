//! expect-abort
//! emitted-has: requireIterablePresent

function copy(source: readonly string[] | undefined): string[] {
  // @ts-expect-error ArrayAccumulation reaches GetIterator and throws when the source is absent.
  return [...source]
}

copy(undefined)
