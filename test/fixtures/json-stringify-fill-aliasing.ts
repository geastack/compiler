// `emit-json.ts`'s write-in-place fast path clears a string cell and serializes
// straight into it, which is only sound when the argument does not read that
// cell. Three shapes, one of which is safe:
//
//   selfDirect   -- the argument IS the cell; clearing it first serializes "".
//   selfDerived  -- the argument is a record whose field was loaded from the
//                   cell. The old guard asked only whether the argument was
//                   itself a read of it, so this walked straight past.
//   independent  -- reads nothing of the cell, and is the case the fast path
//                   exists for.
//
// Only `independent` may render `clear()` + a fill.

export const selfDirect = (): string => {
  let text = 'a'
  text = JSON.stringify(text)
  return text
}

export const selfDerived = (): string => {
  let text = 'b'
  text = JSON.stringify({ text })
  return text
}

export const derivedThroughLength = (): string => {
  let text = 'd'
  text = JSON.stringify({ size: text.length })
  return text
}

export const derivedScalar = (): string => {
  let text = 'ee'
  text = JSON.stringify(text.length)
  return text
}

export const independent = (payload: { n: number }): string => {
  let text = 'c'
  text = JSON.stringify(payload)
  return text
}

// Reached from module scope, because an export nothing calls is shaken out
// before emission and the point of this fixture is the C++ these three render.
export const rendered: number =
  selfDirect().length + selfDerived().length + derivedThroughLength().length + derivedScalar().length + independent({ n: 1 }).length
