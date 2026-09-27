// @ts-nocheck
//! expect: 3 1 2 3 | 2 20 40 | 0
// `Array.from(set)` walks the Set's own iterator (ECMA-262 23.1.2.1 with
// 24.2.3.11): insertion order, one element per distinct key, and the mapper
// sees each key with its index.
const numbers = new Set()
numbers.add(1)
numbers.add(2)
numbers.add(1)
numbers.add(3)
const copied = Array.from(numbers)
const doubled = new Set([10, 20])
const mapped = Array.from(doubled, (value, index) => value * 2 + index * 0)
const empty = Array.from(new Set())
console.log(copied.length, copied[0], copied[1], copied[2], '|', mapped.length, mapped[0], mapped[1], '|', empty.length)
