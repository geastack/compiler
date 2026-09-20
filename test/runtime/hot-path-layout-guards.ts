// The two facts `hot-path-static-layout.ts` relies on, each withdrawn:
//
// - `Counter` is declared inside a function, so every call evaluates a NEW
//   class with its own prototype and method identities. Two instances from
//   two evaluations must not answer for each other, so the method state stays
//   a member of every instance.
// - `delete` clears a declared field's presence bit, so presence is not a
//   program-wide constant here and stays a member too, for every struct in
//   the program.
function make(): number {
  class Counter {
    count: number
    constructor() {
      this.count = 0
    }
    bump(): number {
      this.count += 1
      return this.count
    }
  }
  const counter = new Counter()
  counter.bump()
  return counter.bump()
}

const record: { x: number; y?: number } = { x: 1, y: 2 }
delete record.y
console.log(make(), make(), 'y' in record, Object.keys(record).join(','))
