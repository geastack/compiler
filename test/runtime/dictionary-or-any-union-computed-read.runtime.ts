// A COMPUTED READ OFF A VALUE THAT IS EITHER A TYPED DICTIONARY OR `any`.
//
// A database client's monitor `onHeartbeatSucceeded(hello: Document)`
// is handed a `Document` by one caller and an `any` by another, and reads
// `hello[LEGACY_HELLO_COMMAND]`; `decorateDecryptionResult` reads
// `original[k]` for every own key of a `Document` the same way. Each arm
// answers the read with its own ordinary [[Get]].

const LEGACY = 'ismaster'

interface Doc {
  [key: string]: any
}

function describe(hello: Doc): string {
  if (!('isWritablePrimary' in hello)) {
    hello.isWritablePrimary = hello[LEGACY]
  }
  return `${String(hello.isWritablePrimary)}/${String(hello[LEGACY])}`
}

function viaAny(raw: any): string {
  return describe(raw)
}

const parsed: any = { ismaster: true }
const typed: Doc = { ismaster: false, isWritablePrimary: true }

//! expect: typed=true/false
console.log(`typed=${describe(typed)}`)
//! expect: any=true/true
console.log(`any=${viaAny(parsed)}`)
//! expect: missing=undefined/undefined
console.log(`missing=${describe({})}`)

function keysOf(original: Doc, decrypted: Doc): string {
  const out: string[] = []
  for (const k of Object.keys(decrypted)) {
    const originalValue = original[k]
    out.push(`${k}:${String(originalValue)}`)
  }
  return out.join(',')
}

function keysViaAny(original: any, decrypted: Doc): string {
  return keysOf(original, decrypted)
}

//! expect: keys=a:1,b:undefined
console.log(`keys=${keysOf({ a: 1 }, { a: 2, b: 3 })}`)
const anyOriginal: any = { a: 'x' }
//! expect: keysAny=a:x,b:undefined
console.log(`keysAny=${keysViaAny(anyOriginal, { a: 2, b: 3 })}`)
