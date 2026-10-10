// `new Float32Array( data.arrayBuffers[ key ] )` over a buffer cache that may
// miss: the entry read is `ArrayBuffer | undefined`, a present block is the
// buffer overload (an alias, never a copy) and an absent one is
// ToIndex(undefined), an empty array -- a 3D scene-graph library's interleaved-buffer `clone( data )`.
const cache: Record<string, ArrayBuffer | undefined> = {}
const view = (key: string): Float32Array => {
  const entry = cache[key]
  // @ts-expect-error -- ECMA-262 23.2.5.1 accepts `undefined` (ToIndex), lib.d.ts does not
  return new Float32Array(entry)
}
const block = new Float32Array([1, 2, 3]).buffer
cache['a'] = block
const present = view('a')
present[0] = 7
console.log(present.length, view('b').length, new Float32Array(block)[0])

//! expect: 3 0 7
