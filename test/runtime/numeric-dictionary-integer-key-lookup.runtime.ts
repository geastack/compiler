//! expect: true false true false false true
//! expect: 1 false 2 3
//! expect: 4 true
// `index in this.indexFound` per element (a lazily-parsed document's `getElement`)
// asks a `Record<number, boolean>` by an integer; the answer is read off the
// key's digits in a stack buffer. Any number that is not a non-negative
// integer below 2^53 spells its key the long way and must still agree.
const found: Record<number, boolean> = Object.create(null)
found[3] = true
found[0] = true
found[9007199254740992] = true
found[1.5] = false
found[-1] = false
found[1e21] = true
console.log(3 in found, 4 in found, 0 in found, 2 in found, (-2) in found, 1e21 in found)
const counts: Record<number, number> = Object.create(null)
counts[1] = 1
counts[2] = 2
counts[10] = 3
console.log(counts[1], 5 in counts, counts[2], counts[10])
let size = 0
for (let position = 0; position < 4; position++) {
  found[position + 100] = true
  size += 100 + position in found ? 1 : 0
}
console.log(size, (-0) in found && 0 in found && found[9007199254740992])
