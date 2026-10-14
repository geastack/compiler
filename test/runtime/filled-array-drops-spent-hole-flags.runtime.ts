//! expect: filled=12,12,4,true,0,2,4,6
//! expect: sparse=4,false,true,7
//! expect: refilled=13,true,0,1,2,3
//! expect: grown=false,6,0,1,2,3
//! expect: shrunk=true,0,1,2,3,13
//! expect: undefined=2,u,2
// An array created with a length (or grown past its end) records its holes in a
// flags vector, and filling every slot only zeroes the flags. The runtime drops
// a vector that flags nothing once a read scan reaches the last element, so
// later reads take the dense path; every hole question must still answer as the
// language does -- before, after and across a later growth and shrink.

function sum(values: number[]): number {
  let total = 0
  for (let i = 0; i < values.length; i++) total += values[i]!
  return total
}

const cache: number[] = new Array(4)
for (let i = 0; i < 4; i++) cache[i] = i * 2
console.log(`filled=${sum(cache)},${sum(cache)},${cache.length},${0 in cache},${cache.join(',')}`)

const sparse: number[] = []
sparse[3] = 7
console.log(`sparse=${sparse.length},${1 in sparse},${3 in sparse},${sparse[3]}`)
sparse[0] = 1
sparse[1] = 2
sparse[2] = 3
console.log(`refilled=${sum(sparse)},${1 in sparse},${Object.keys(sparse).join(',')}`)
sparse.length = 6
console.log(`grown=${5 in sparse},${sparse.length},${Object.keys(sparse).join(',')}`)
sparse.length = 4
console.log(`shrunk=${0 in sparse},${Object.keys(sparse).join(',')},${sum([2, 4, 7])}`)

const maybe: (number | undefined)[] = [1, undefined]
maybe[1] = 1
const seen = maybe.map((value) => (value === undefined ? 'u' : String(value)))
maybe[0] = undefined
console.log(`undefined=${maybe.length},${maybe[0] === undefined ? 'u' : 'd'},${seen.length}`)
