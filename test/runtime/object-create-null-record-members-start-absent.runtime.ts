// A RECORD MINTED BY `Object.create(null)` HAS NO OWN PROPERTIES.
//
// A database client's `parseOptions(...): ClientOptions` builds
// `const clientOptions = Object.create(null)`, writes only the options it was
// given, and then tests `if (client && clientOptions.autoEncryption)`.
// `autoEncryption` is a REQUIRED member of `ClientOptions`, but nothing wrote
// it, so node reads `undefined` and skips `Encrypter.checkForCipher()`.
// The native record started every required member present (an empty `Ref`
// behind a presence bit initialised `true`) and the truthiness of an object
// reference folded to `has_value() && true`, so the check ran and threw the
// missing-dependency error before the driver opened a socket.
//
// Every declared member of such a record is absent until written: a read
// yields `undefined`, `in` and `Object.keys` do not see it, and an object
// reference tests truthy only when one is really held.

interface Inner {
  x: number
}

interface Opts {
  a: number
  b: Inner
  c: string
}

// Each creation form gets a type of its own (structural types intern by
// shape, so the extra member keeps them apart): one form must not pass on
// the strength of another's census.
interface RetOpts {
  a: number
  b: Inner
  e: number
}

interface CreatedOpts {
  a: number
  b: Inner
  c: string
  d: boolean
}

function viaReturn(flag: boolean): RetOpts {
  const o = Object.create(null)
  o.a = 1
  if (flag) o.b = { x: 2 }
  let hit = 'no'
  if (o.b) hit = 'yes'
  console.log(`ret flag=${flag} undef=${o.b === undefined} in=${'b' in o} keys=${Object.keys(o).join(',')} hit=${hit}`)
  return o
}

//! expect: ret flag=false undef=true in=false keys=a hit=no
viaReturn(false)
//! expect: ret flag=true undef=false in=true keys=a,b hit=yes
const full = viaReturn(true)
//! expect: full.b.x=2
console.log(`full.b.x=${full.b.x}`)

const asserted = Object.create(null) as CreatedOpts
asserted.a = 1
let assertedHit = 'no'
if (asserted.b) assertedHit = 'yes'
//! expect: asserted undef=true in=false keys=a hit=no c=undefined
console.log(
  `asserted undef=${asserted.b === undefined} in=${'b' in asserted} keys=${Object.keys(asserted).join(',')} hit=${assertedHit} c=${asserted.c}`
)

const literal = {} as Opts
literal.c = 'set'
let literalHit = 'no'
if (literal.b) literalHit = 'yes'
//! expect: literal undef=true in=false keys=c hit=no
console.log(`literal undef=${literal.b === undefined} in=${'b' in literal} keys=${Object.keys(literal).join(',')} hit=${literalHit}`)

class Node2 {
  constructor(readonly v: number) {}
}

function pick(n: number): Node2 | null {
  return n > 0 ? new Node2(n) : null
}

function pickRecord(n: number): Inner | undefined {
  return n > 0 ? { x: n } : undefined
}

const truthy = (n: number): string => {
  const c = pick(n)
  const r = pickRecord(n)
  return `${c ? 'C' : 'c'}${r ? 'R' : 'r'}${!c ? '!' : '.'}${c && r ? 'both' : 'none'}`
}

//! expect: refs CR.both|cr!none
console.log(`refs ${truthy(1)}|${truthy(0)}`)

// A declared member no write ever filled holds no object: its handle is
// empty, and an empty handle is the `undefined` node reads there, not an
// object that is truthy by virtue of being an object.
class Lazy {
  inner!: Inner
  items!: number[]
  fill(): void {
    this.inner = { x: 5 }
    this.items = [1]
  }
}

const lazy = new Lazy()
const before = `${lazy.inner ? 'I' : 'i'}${lazy.items ? 'A' : 'a'}`
lazy.fill()
//! expect: lazy ia->IA
console.log(`lazy ${before}->${lazy.inner ? 'I' : 'i'}${lazy.items ? 'A' : 'a'}`)
