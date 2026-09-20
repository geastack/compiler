// The receivers a keyed-collection or array write can arrive through, beyond a
// directly-annotated `Map`/`Array`. `flow/value-flow.ts` gates its
// `collection-key`/`collection-value`/`array-append`/`array-fill` edges on the
// receiver's resolved type, which is right -- a name match fired for a user
// class declaring `set` (see `user-collection-method-names.ts`). This fixture
// is the other side of that gate: every receiver below IS a standard
// collection or array, so every write below must still be seen. A dropped
// edge here types a cell more narrowly than the program fills it, which is a
// silent miscompile rather than a box.

class Registry extends Map<string, number> {}

export const throughSubclass = (): number => {
  const registry = new Registry()
  registry.set('a', 1)
  return registry.get('a') ?? 0
}

export const throughGeneric = <T extends Map<string, number>>(cache: T): number => {
  cache.set('b', 2)
  return cache.get('b') ?? 0
}

export const throughOptional = (cache: Map<string, number> | null): number => {
  if (cache === null) return 0
  cache.set('c', 3)
  return cache.get('c') ?? 0
}

export const throughTuple = (): number => {
  const pair: [number, number] = [0, 0]
  pair.fill(7)
  return pair[0]
}

export const throughTypedArray = (): number => {
  const buffer = new Float32Array(4)
  buffer.fill(1.5)
  return buffer[0] ?? 0
}

export const throughPlainArray = (): number => {
  const values: number[] = []
  values.push(9)
  values.fill(9)
  return values[0] ?? 0
}
