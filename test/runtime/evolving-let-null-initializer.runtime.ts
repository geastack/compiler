// An unannotated `let x = null` is an auto-typed (evolving) binding: the
// checker's declared type is `any`, and each reference reads the flow type of
// the last assignment. The binding's carrier must hold every value it can
// actually hold -- including the initializer's null -- not only the values
// assigned or returned later.
class MissingDependencyError extends Error {
  dependencyName: string
  constructor(message: string, dependencyName: string) {
    super(message)
    this.dependencyName = dependencyName
  }
}

interface Encryption {
  name: string
  version: number
}

function loadEncryption(fail: boolean): Encryption {
  if (fail) throw new Error('Cannot find module')
  return { name: 'client-encryption', version: 6 }
}

function getEncryption(fail: boolean): Encryption | { kModuleError: MissingDependencyError } {
  let encryption = null
  try {
    encryption = loadEncryption(fail)
  } catch (error) {
    const kModuleError = new MissingDependencyError('optional dependency missing', 'client-encryption')
    return { kModuleError }
  }
  return encryption
}

const ok = getEncryption(false)
if ('kModuleError' in ok) console.log('error', ok.kModuleError.dependencyName)
else console.log('loaded', ok.name, ok.version)
//! expect: loaded client-encryption 6

const failed = getEncryption(true)
if ('kModuleError' in failed) console.log('error', failed.kModuleError.dependencyName, failed.kModuleError.message)
else console.log('loaded', failed.name, failed.version)
//! expect: error client-encryption optional dependency missing

// The same shape where the assigned value is one no census can type (as
// a database client's `require(...)` is): the binding's evidence for that write is the
// function's stated return type, and the initializer's null must still join it.
function parseEncryption(text: string): Encryption {
  let encryption = null
  try {
    // The typed native JSON reader stops at a malformed document rather than
    // throwing, so the failure path throws explicitly.
    if (text === '') throw new Error('empty document')
    encryption = JSON.parse(text)
  } catch (error) {
    return { name: 'fallback', version: 0 }
  }
  return encryption
}

const parsed = parseEncryption('{"name":"parsed-encryption","version":7}')
console.log(parsed.name, parsed.version)
//! expect: parsed-encryption 7

const unparsed = parseEncryption('')
console.log(unparsed.name, unparsed.version)
//! expect: fallback 0

interface Point {
  x: number
  y: number
}

function maybePoint(make: boolean): string {
  let point = null
  if (make) point = { x: 3, y: 4 }
  if (point === null) return 'none'
  return `${point.x},${point.y}`
}

console.log(maybePoint(true), maybePoint(false))
//! expect: 3,4 none

function pointOrNull(make: boolean): Point | null {
  let point = null
  if (make) point = { x: 1, y: 2 }
  return point
}

const p = pointOrNull(true)
const q = pointOrNull(false)
console.log(p === null ? 'null' : p.x + p.y, q === null ? 'null' : q.x)
//! expect: 3 null

let n = null
n = 5
console.log(n + 1)
//! expect: 6

let u = undefined
u = 'text'
console.log(u.length)
//! expect: 4

let later
later = { label: 'late' }
console.log(later.label)
//! expect: late
