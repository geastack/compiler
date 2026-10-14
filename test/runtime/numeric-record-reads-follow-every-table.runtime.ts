//! expect: first=true,false,-,true,-
//! expect: second=false,true,-,-,true
//! expect: churn=false,true,-,true,false
//! expect: wide=4,20,36,-,2
//! expect: odd=7,8,-,9
// A `Record<number, T>` read by an integer key asks the position that key was
// last found at in the same table (three's `enabledCapabilities[id]`, read per
// `enable`/`disable` call). The guess is per table and verified by the key, so
// the answers must stay the language's: two tables sharing low key bits,
// deletes that move later keys, a table past its scan limit, keys that differ
// only in high bits, and non-integer keys.

const first: Record<number, boolean> = {}
const second: Record<number, boolean> = {}
first[2884] = true
first[3042] = false
first[2929] = true
second[3042] = true
second[2884] = false
second[32823] = true

const read = (table: Record<number, boolean>, key: number): string => {
  const value = table[key]
  return value === undefined ? '-' : String(value)
}
const keys = [2884, 3042, 2960, 2929, 32823]
console.log('first=' + keys.map((key) => read(first, key)).join(','))
console.log('second=' + keys.map((key) => read(second, key)).join(','))

// Delete and re-add: positions move, the hint must not answer a stale entry.
const churn: Record<number, boolean> = {}
for (const key of keys) churn[key] = false
for (const key of keys) read(churn, key)
delete churn[2884]
delete churn[2960]
churn[3042] = true
churn[2960] = true
churn[2884] = false
console.log('churn=' + [2884, 3042, 1, 2960, 32823].map((key) => read(churn, key)).join(','))

// Past the scan limit (hashed index), keys 8 apart share a hint slot.
const wide: Record<number, number> = {}
for (let key = 0; key < 40; key += 2) wide[key] = key * 2
const wideRead = (key: number): string => (wide[key] === undefined ? '-' : String(wide[key]))
const order = [2, 10, 18, 3, 1]
for (let round = 0; round < 3; round++) for (const key of order) wideRead(key)
delete wide[1]
wide[1] = 2
console.log('wide=' + order.map(wideRead).join(','))

// Non-integer and negative keys keep their own spellings.
const odd: Record<number, number> = {}
odd[0.5] = 7
odd[-1] = 8
odd[1e21] = 9
console.log('odd=' + [0.5, -1, 1, 1e21].map((key) => (odd[key] === undefined ? '-' : String(odd[key]))).join(','))
