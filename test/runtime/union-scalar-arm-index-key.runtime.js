// @ts-nocheck
//! expect: 4 1 1
//! expect: 2 3 4
//! expect: undefined
// An array index off `number | Array<number>`: the array answers its
// element, the number `undefined` (no wrapper or prototype has an
// integer-indexed property). three's `Backend.compute` reads
// `dispatchSize[ 0 ]` after its number branch rewrote the local.
/** @param {number|Array<number>} dispatchSize */
const dispatch = (dispatchSize) => {
  if (typeof dispatchSize === 'number' && dispatchSize > 100) {
    dispatchSize = [Math.ceil(dispatchSize / 64), 1, 1]
  }
  console.log(dispatchSize[0], dispatchSize[1] || 1, dispatchSize[2] || 1)
}
dispatch(200)
dispatch([2, 3, 4])
/** @param {number|Array<number>} value */
const first = (value) => value[0]
console.log(first(5))
export {}
