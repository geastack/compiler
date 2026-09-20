// Two silent wrong answers on an array pattern with defaults over a plain
// array, found through tsc's semver.ts pattern over a RegExpExecArray and
// reproduced on `(string | undefined)[]`:
//
// 1. Every defaulted element advanced the NEXT position by one: the lowering
//    recovered an element's index by counting every step on the pattern's
//    evaluation chain, and a defaulted element contributes two (its read and
//    its `default-value` step). `c` below read slot 4 and `d` slot 6.
// 2. A stored absent element read as a present empty string: the present arm
//    of the absence-capable element read converted the element into the
//    result's PAYLOAD (`(*x)`, the empty payload for an absent optional) and
//    re-wrapped it, so `b`'s default never fired on `undefined`.
function read(arr: (string | undefined)[]): string {
  const [, a, b = 'B', c = 'C', d = 'D', e] = arr
  return `${a}|${b}|${c}|${d}|${e}`
}
function nested(rows: [number, number[], number]): string {
  const [first = 0, [x = -1, y = -1] = [7, 8], last = 9] = rows
  return `${first},${x},${y},${last}`
}
console.log(read(['0', '1', '2', '3', '4', '5']), read(['0', '1', undefined, '3']), read(['0']))
console.log(nested([1, [2, 3], 4]), nested([1, [2], 4]))
//! expect: 1|2|3|4|5 1|B|3|D|undefined undefined|B|C|D|undefined
//! expect: 1,2,3,4 1,2,-1,4
