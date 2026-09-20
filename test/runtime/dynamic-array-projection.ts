// Corrected against real `node`, which prints `false` in the third position:
// the index probed with `in` is a hole, and `in` answers absence for a hole.
//! expect: 5,false,false,undefined,undefined,9,11
//! emitted-has: gea::runtime::iterator::getIterator

// `Array.isArray` proves the live dynamic value is an Array without turning
// it into a fresh `ArrayObject<Value>`.  The aliases below must consequently
// observe the same indexed slots, holes, and length.
const source: any = [, undefined, 9]
const alias: any = source

if (!Array.isArray(source)) throw new Error('array proof failed')

alias[4] = 11
delete alias[1]

const [hole, deleted, nine, skipped, eleven] = source
console.log(`${source.length},${0 in source},${1 in source},${hole},${deleted},${nine},${eleven}`)
