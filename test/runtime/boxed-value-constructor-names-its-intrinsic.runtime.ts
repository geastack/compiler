// `constructor` read off a value held as `any` is inherited from the box's
// prototype: %Array% for an array, %Object% for an object literal, and the
// primitive's wrapper constructor for a string, number or boolean.
// `isArrayLike` is @zag-js/utils `equal.ts` line 1, word for word.
//! expect: true false false
//! expect: function Array 1 true
//! expect: function Object
//! expect: String Number Boolean
// prettier-ignore
const isArrayLike = (value: any) => value?.constructor.name === "Array"
console.log(isArrayLike([10]), isArrayLike({ a: 1 }), isArrayLike(null))

const list: any = [10]
const other: any = ['b']
console.log(typeof list.constructor, list.constructor.name, list.constructor.length, list.constructor === other.constructor)

const record: any = { a: 1 }
console.log(typeof record.constructor, record.constructor.name)

const text: any = 'x'
const count: any = 1
const flag: any = true
console.log(text.constructor.name, count.constructor.name, flag.constructor.name)
export {}
