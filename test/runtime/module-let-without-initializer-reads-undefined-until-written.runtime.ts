//! expect: loads 1
//! expect: compress: compressor:abc compressor:def
//! expect: before: true
//! expect: count: 0 1 2
//! expect: local: 7
//! expect: lazy: 41 41
//! expect: library: missing compressor / compressor 2

// A module `let` declared without an initializer holds `undefined` until the
// first write, and the checker never proves definite assignment across
// functions. A database client's compression module (`let compressor: Compressor` then
// `if (!compressor) compressor = loadCompressor()`) is the idiom: carried as its declared type,
// `!compressor` folds to false and the loader never runs.

interface Codec {
  readonly name: string
  encode(input: string): string
}

let codec: Codec
let loads = 0

function loadCodec(): Codec {
  loads++
  return { name: 'compressor', encode: (input: string) => `compressor:${input}` }
}

function compress(input: string): string {
  if (!codec) codec = loadCodec()
  return codec.encode(input)
}

const first = compress('abc')
const second = compress('def')
console.log(`loads ${loads}`)
console.log(`compress: ${first} ${second}`)

let label: string
function isUnset(): boolean {
  return label === undefined
}
console.log(`before: ${isUnset()}`)

let counter: number
function bump(): number {
  if (counter === undefined) counter = 0
  else counter++
  return counter
}
const a = bump()
const b = bump()
const c = bump()
console.log(`count: ${a} ${b} ${c}`)

// A write that dominates every read in the same function stays the plain type.
function local(): number {
  let x: number
  x = 7
  return x
}
console.log(`local: ${local()}`)

let answer: number
function lazy(): number {
  answer ??= 41
  return answer
}
console.log(`lazy: ${lazy()} ${lazy()}`)

// The database client's shape exactly: the cell's declared type is itself a union, and
// the reads narrow it with `in` after the lazy load.
type Library = { kModuleError: string } | { compress(input: string): string }
let library: Library
let libraryLoads = 0
function loadLibrary(): void {
  if (!library) {
    libraryLoads++
    library = libraryLoads > 5 ? { compress: (input: string) => input } : { kModuleError: 'missing compressor' }
  }
}
function useLibrary(): string {
  loadLibrary()
  if ('kModuleError' in library) return library.kModuleError
  return library.compress('x')
}
console.log(`library: ${useLibrary()} / compressor ${useLibrary() === 'missing compressor' ? libraryLoads + 1 : 0}`)
