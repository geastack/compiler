//! dynamic-fallback
//! expect: got 3 none got 5 | above 4 none
// A local written only inside a callback: the checker's narrowing from its
// initializer does not see that write, so every read of the cell takes the
// cell's own type -- semver's minVersion keeps its `setMin` this way.
'use strict'
function found (list) {
  let value = null
  list.forEach((x) => { if (x > 1) value = x })
  if (value !== null) return 'got ' + value
  return 'none'
}
function firstAbove (list) {
  let setMin = null
  list.forEach((x) => {
    if (setMin === null && x > 1) setMin = x
  })
  if (setMin && setMin > 2) return 'above ' + setMin
  return 'none'
}
console.log(found([1, 3]), found([1]), found([2, 5]), '|', firstAbove([1, 4, 9]), firstAbove([1, 2]))
