// A Map past a handful of entries finds keys through a hash index beside its
// insertion-ordered storage. Nothing about that may be observable: order,
// SameValueZero (-0 is +0, NaN is one key), size, delete during iteration and
// re-insertion after delete must all read exactly as in Node. A seeded random
// interleaving of every operation over number, string and object keys is
// digested into a few numbers that the expectations below pin.

let seed = 12345
const next = (n: number): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
const mix = (h: number, v: number): number => (Math.imul(h ^ v, 16777619) >>> 0)
const textHash = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i))
  return h
}

const specials = [0, -0, NaN, Infinity, -Infinity, 1.5, -2.25, 1e21]
const numberKey = (): number => (next(10) === 0 ? specials[next(specials.length)]! : next(300))

const numbers = new Map<number, number>()
let h = 2166136261
for (let step = 0; step < 6000; step++) {
  const op = next(10)
  const key = numberKey()
  if (op < 4) numbers.set(key, step)
  else if (op < 6) h = mix(h, numbers.get(key) ?? -1)
  else if (op < 7) h = mix(h, numbers.has(key) ? 1 : 0)
  else if (op < 9) h = mix(h, numbers.delete(key) ? 1 : 0)
  else if (next(50) === 0) numbers.clear()
  h = mix(h, numbers.size)
  if (step % 500 === 0) for (const [k, v] of numbers) h = mix(mix(h, Object.is(k, -0) ? 7 : k === k ? k | 0 : 9), v)
}
console.log('numbers', h, numbers.size, numbers.has(-0), numbers.get(NaN) ?? -1)

const strings = new Map<string, number>()
let hs = 2166136261
for (let step = 0; step < 5000; step++) {
  const op = next(10)
  const key = 'k' + next(60)
  if (op < 4) strings.set(key, step)
  else if (op < 7) hs = mix(hs, strings.get(key) ?? -1)
  else if (op < 9) hs = mix(hs, strings.delete(key) ? 1 : 0)
  else if (next(80) === 0) strings.clear()
  hs = mix(hs, strings.size)
}
for (const [k, v] of strings) hs = mix(mix(hs, textHash(k)), v)
console.log('strings', hs, strings.size)

class Box {
  id: number
  constructor(id: number) {
    this.id = id
  }
}
const boxes: Box[] = []
for (let i = 0; i < 30; i++) boxes.push(new Box(i))
const objects = new Map<Box, number>()
let ho = 2166136261
for (let step = 0; step < 4000; step++) {
  const op = next(10)
  const key = boxes[next(boxes.length)]!
  if (op < 4) objects.set(key, step)
  else if (op < 7) ho = mix(ho, objects.get(key) ?? -1)
  else if (op < 9) ho = mix(ho, objects.delete(key) ? 1 : 0)
  ho = mix(ho, objects.size)
}
for (const [k, v] of objects) ho = mix(mix(ho, k.id), v)
console.log('objects', ho, objects.size)

// Delete and re-insert while iterating: a deleted entry is skipped, an entry
// added during the walk is visited, and a re-inserted key moves to the end.
const walk = new Map<number, string>()
for (let i = 0; i < 20; i++) walk.set(i, 'v' + i)
const seen: string[] = []
for (const [k, v] of walk) {
  seen.push(k + ':' + v)
  if (k % 3 === 0) walk.delete(k + 1)
  if (k === 5) walk.set(2, 'again')
  if (k === 8) {
    walk.delete(0)
    walk.set(0, 'back')
  }
  if (k < 4) walk.set(100 + k, 'added' + k)
  if (seen.length > 60) break
}
console.log('walk', seen.join(','))
console.log('order', [...walk.keys()].join(','), walk.size)

//! expect: numbers 3548090912 68 false -1
//! expect: strings 3489454701 19
//! expect: objects 216773289 12
//! expect: walk 0:v0,2:v2,3:v3,5:v5,6:v6,8:v8,9:v9,11:v11,12:v12,14:v14,15:v15,17:v17,18:v18,100:added0,102:added2,0:back
//! expect: order 2,3,5,6,8,9,11,12,14,15,17,18,100,102,0 15
