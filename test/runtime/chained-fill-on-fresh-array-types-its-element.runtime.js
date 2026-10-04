// @ts-nocheck
//! expect: padded 7,0,0 3
//! expect: bound 5,5 2
// three's TSLCore `verifyParamsLimit`: `params.concat( new Array( minParams -
// params.length ).fill( 0 ) )` on an untyped `params`. `fill` returns its
// receiver (ECMA-262 23.1.3.7), so the chain's value is the `new Array( n )`
// allocation, and the `fill` argument is that allocation's element -- the
// same evidence `const pad = new Array( n ); pad.fill( 0 )` gives.
let minParams = 3
function verifyParamsLimit(params) {
  if (minParams !== undefined && params.length < minParams) {
    return params.concat(new Array(minParams - params.length).fill(0))
  }
  return params
}
const padded = verifyParamsLimit([7])
console.log('padded', padded.join(','), padded.length)

const bound = new Array(2).fill(5)
console.log('bound', bound.join(','), bound.length)
