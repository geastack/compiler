// A bare `new Map()` states nothing to the checker, so `slots.get( key )` is
// typed `any` no matter what carrier this compiler selects for `slots`: a
// prototype call's result comes from the CALLEE'S SIGNATURE, instantiated from
// the receiver EXPRESSION. The census knows what the program stores; this is
// the read that has to agree with it.
class Slot {
  constructor(readonly count: number) {}
}

const slots = new Map()
slots.set('a', new Slot(4))
slots.set('b', new Slot(9))

function count(key: string): number {
  const found = slots.get(key)
  return found === undefined ? -1 : found.count
}

console.log(`${count('a')},${count('b')},${count('z')}`)
