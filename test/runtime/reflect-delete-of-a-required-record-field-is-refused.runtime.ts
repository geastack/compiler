//! expect-refusal: property-access:record:delete:false
//! expect-refusal: property-access:record:delete:true
// Reflect.deleteProperty is the same [[Delete]] as the `delete` operator, so it
// is refused by the same rows. A required field's presence bit exists, but no
// typed read consults it: after the delete, `actions.b` still read the old
// function, and the live `Acts` view below threw "a live native field has no
// source read protocol" where Node prints `missing b`. The operator is already
// refused here (native-required-record-delete.js); a computed key may name a
// required field too, so it is refused like `delete actions[key]`.
interface Acts {
  a: () => void
  b: () => void
}
interface Machine {
  implementations?: { actions?: Acts | undefined } | undefined
}
class Runner {
  private machine: Machine
  constructor(machine: Machine) {
    this.machine = machine
  }
  run(keys: ('a' | 'b')[]): void {
    for (const s of keys) {
      const fn = this.machine.implementations?.actions?.[s]
      if (fn) fn()
      else console.log('missing ' + s)
    }
  }
}
const actions = { a: () => console.log('a'), b: () => console.log('b') }
Reflect.deleteProperty(actions, 'b')
new Runner({ implementations: { actions } }).run(['a', 'b'])

const counts = { first: 1, second: 2 }
const keys: ('first' | 'second')[] = ['second']
keys.forEach((key) => Reflect.deleteProperty(counts, key))
console.log(counts.second)
