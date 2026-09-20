// Descriptor attributes for an indexed record live beside its native index
// values. This is intentionally a typed receiver: the call does not need an
// `any` cast or turn the record itself into `gea::Value`.
interface Indexed {
  fixed: number
  [key: string]: number
}

// The top-level module body is strict like the rest of this compiler's
// output (see the header comment on `strictRejected` below for the sibling
// case) -- so `delete` of a non-configurable property here THROWS rather
// than returning `false` as it would in a sloppy script. Real Node run as an
// ES module confirms it: `TypeError: Cannot delete property 'hidden' of
// #<Object>`, uncaught, before this statement's own `console.log` ever
// prints. `rejects` observes that outcome instead of the call's return
// value, exactly like `static-property-descriptors.runtime.js`'s helper of
// the same name.
function rejects(action: () => void): string {
  try {
    action()
    return 'missing'
  } catch (error) {
    return error instanceof Error ? error.name : 'unexpected'
  }
}

const indexed: Indexed = { fixed: 1 }
Object.defineProperty(indexed, 'hidden', {
  value: 2,
  writable: false,
  enumerable: false,
  configurable: false
})

const descriptor = Object.getOwnPropertyDescriptor(indexed, 'hidden')
const reflection: any = indexed

//! expect: 2|false|false|false|fixed|TypeError
console.log(
  [
    indexed.hidden,
    descriptor?.writable,
    descriptor?.enumerable,
    descriptor?.configurable,
    Object.keys(reflection).join(','),
    rejects(() => {
      delete indexed.hidden
    })
  ].join('|')
)

// A strict assignment must observe the same native writable bit as the host
// define operation; sloppy mode would simply leave the value unchanged.
let strictRejected = false
try {
  ;(() => {
    'use strict'
    indexed.hidden = 3
  })()
} catch {
  strictRejected = true
}

//! expect: true|2
console.log([strictRejected, indexed.hidden].join('|'))

interface NumericIndexed {
  fixed: string
  [key: number]: string
}

const numeric: NumericIndexed = { fixed: 'n' }
Object.defineProperty(numeric, 4, { value: 'four', writable: false, enumerable: false, configurable: true })
const numericDescriptor = Object.getOwnPropertyDescriptor(numeric, 4)

interface SymbolIndexed {
  fixed: string
  [key: symbol]: string
}

const token = Symbol('token')
const symbolic: SymbolIndexed = { fixed: 's' }
Object.defineProperty(symbolic, token, { value: 'symbol', writable: true, enumerable: false, configurable: false })
const symbolDescriptor = Object.getOwnPropertyDescriptor(symbolic, token)

//! expect: four|false|false|symbol|false|false
console.log(
  [
    numeric[4],
    numericDescriptor?.writable,
    numericDescriptor?.enumerable,
    symbolic[token],
    symbolDescriptor?.enumerable,
    symbolDescriptor?.configurable
  ].join('|')
)
