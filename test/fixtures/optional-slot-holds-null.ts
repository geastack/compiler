// A slot that can be ABSENT, `null`, or a value -- the three-state shape a
// cache built a property at a time takes when the value it caches is itself
// nullable. `object-bag-bindings.ts` refuses to bind such a slot
// (`null-carrier`) on the grounds that one flag cannot say which of the two
// absent values a member holds; this fixture is the check on that claim for a
// payload that carries its OWN null -- a refcounted class reference, where
// `representation/optional.ts` collapses `T | null` onto the reference itself
// and leaves the optional's flag free to mean `undefined` alone.

class Extension {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

interface Cache {
  slot?: Extension | null
}

const describe = (cache: Cache): string => {
  const slot = cache.slot
  if (slot === undefined) return 'absent'
  if (slot === null) return 'null'
  return 'value:' + slot.value
}

export const main = (): void => {
  const empty: Cache = {}
  const missing: Cache = { slot: null }
  const present: Cache = { slot: new Extension(7) }
  console.log(describe(empty) + ',' + describe(missing) + ',' + describe(present))
}

main()
