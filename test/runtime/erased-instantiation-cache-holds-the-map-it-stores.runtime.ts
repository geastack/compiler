// A module cache states its value as an erased instantiation,
// `Map<string, St<any>>`, because a generic function cannot name its own `T`
// at module scope. The Map it stores and later hands back is the one the
// function built at `St<T>`: one object, read back through the assertion that
// undoes the erasure. @zag-js/core's `ensureStateIndex` (state.ts) is the
// shape, reached there only through other generic functions, as `idsOf` does
// here: the cache is then one storage for a copy minted inside another copy.
//
// Node prints `true 3 on c true` and `a,b,c`: the second call returns the
// same Map, with the entry the caller added after the first call.
interface Schema {
  state: string
}
interface St<T extends Schema> {
  id?: string | undefined
  tags?: T['state'][] | undefined
}
interface Machine<T extends Schema> {
  states: Record<string, St<T>>
}

const cache = new WeakMap<object, Map<string, St<any>>>()

function ensure<T extends Schema>(machine: Machine<T>) {
  const cached = cache.get(machine)
  if (cached) return cached as Map<string, St<T>>
  const index = new Map<string, St<T>>()
  for (const [key, state] of Object.entries(machine.states)) index.set(key, state)
  cache.set(machine, index as Map<string, St<any>>)
  return index
}

interface Toggle {
  state: 'off' | 'on'
}
const machine: Machine<Toggle> = { states: { off: { id: 'a', tags: ['on'] }, on: { id: 'b' } } }
const first = ensure(machine)
first.set('extra', { id: 'c' })
const second = ensure(machine)
console.log(first === second, second.size, second.get('off')?.tags?.[0], second.get('extra')?.id, cache.has(machine))
//! expect: true 3 on c true

function idsOf<T extends Schema>(machine: Machine<T>): string {
  return [...ensure(machine).values()].map((state) => state.id).join(',')
}
console.log(idsOf(machine))
//! expect: a,b,c
