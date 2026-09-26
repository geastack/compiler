// @ts-nocheck
//! expect: THREE.third 0
//! expect: THREE.a 1
//! expect: popped z [x,y]
// three's `utils.js` `warn`: `'THREE.' + params.shift()` over a rest array
// every caller fills with strings. `shift` answers an optional element, and
// boxing it for the concatenation reads it twice -- once for presence, once
// for the payload -- so the call itself must run once, not once per read.
/** @param {...any} params */
function warn(...params) {
  const message = 'THREE.' + params.shift()
  console.log(message, params.length)
}
warn('third')
warn('a', 'b')

/** @param {...any} items */
function last(...items) {
  const popped = 'popped ' + items.pop()
  console.log(popped, '[' + items.join(',') + ']')
}
last('x', 'y', 'z')
