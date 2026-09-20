type Pair = { x: number; y: number }

function read(pair: Pair, key: 'x' | 'y'): number {
  return pair[key]
}

// A region-owned object can be observed through the dynamic sidecar protocol;
// this negative fixture must keep the full native route and must not silently
// use the fixed-field recipe.
const pair: Pair = { x: 2, y: 3 }
console.log(read(pair, 'x'))
//! expect: 2
