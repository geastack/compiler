// Iterable states an element protocol, not the physical object implementing
// it. The returned Array must keep its array carrier and identity.
const values = (): Iterable<number> => [2, 5]

let total = 0
for (const value of values()) total += value
console.log(total)
