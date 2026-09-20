type Pair = { x: number; y: number }

function read(key: 'x' | 'y'): number {
  const pair: Pair = { x: 2, y: 3 }
  return pair[key]
}

console.log(read('x'), read('y'))
//! expect: 2 3
