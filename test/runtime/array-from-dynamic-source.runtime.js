// @ts-nocheck
//! expect: typed 3 1,2,255
//! expect: array 3 7,u,9
//! expect: like 2 a,b
//! expect: string 2 😀,x
//! expect: iterable 2 x,y
//! expect: json 2 1,b
//! expect: number 0
//! expect: null TypeError
//! emitted-has: gea::arrayFromValue(
// `Array.from(items)` over a source the checker types `any` (three's
// `serializeImage` copies `image.data`, a DataTexture's pixel array, off its
// `Source`). The parsed JSON keeps the field boxed. ECMA-262 23.1.2.1 asks the
// VALUE whether it is iterable -- GetMethod(@@iterator) -- and reads anything
// else as an array-like, so a string iterates by code point while a plain
// `{ length }` object is indexed and a primitive number yields nothing. An
// `undefined` element is copied as itself, printed `u`.
class Source {
  /** @param {any} data */
  constructor(data) {
    /** @type {any} */
    this.data = data
  }
}
class Pair {
  constructor() {
    this.first = 'x'
    this.second = 'y'
  }
  *[Symbol.iterator]() {
    yield this.first
    yield this.second
  }
}
/** @param {Source} image */
const copy = (image) => {
  const out = Array.from(image.data)
  return out.length + (out.length > 0 ? ' ' + out.map((value) => (value === undefined ? 'u' : value)).join(',') : '')
}
console.log('typed', copy(new Source(new Uint8Array([1, 2, 255]))))
console.log('array', copy(new Source([7, undefined, 9])))
console.log('like', copy(new Source({ length: 2, 0: 'a', 1: 'b' })))
console.log('string', copy(new Source('😀x')))
console.log('iterable', copy(new Source(new Pair())))
console.log('json', copy(new Source(JSON.parse('[1,"b"]'))))
console.log('number', copy(new Source(5)))
try {
  copy(new Source(null))
  console.log('null none')
} catch (error) {
  console.log('null', error instanceof TypeError ? 'TypeError' : 'other')
}
