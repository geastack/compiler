function describe(error?: Error): string {
  if (error === undefined) return 'none'
  const coded = error as Error & { code?: string; errno?: number }
  return `${error.message} ${String(coded.code)} ${String(coded.errno)} ${error instanceof Error}`
}

const aborted = Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' })
console.log(aborted.message, aborted.code)
console.log(describe(Object.assign(new Error('EISDIR, read'), { code: 'EISDIR', errno: -21 })))
console.log(describe(undefined))

const details: { code: string } = { code: 'ENOENT' }
Object.defineProperty(details, 'syscall', { value: 'open', enumerable: true })
const missing = Object.assign(new Error('missing'), details) as Error & { code: string; syscall?: string }
console.log(missing.code, String(missing.syscall))

function extra(present: boolean): { code: string } | undefined {
  return present ? { code: 'EPIPE' } : undefined
}
const skipped = Object.assign(new Error('skipped'), extra(false)) as Error & { code?: string }
const copied = Object.assign(new Error('copied'), extra(true)) as Error & { code?: string }
console.log(String(skipped.code), String(copied.code))

const hidden = { code: 'EHIDDEN', errno: 7 }
Object.defineProperty(hidden, 'code', { value: 'EHIDDEN', writable: true, enumerable: false, configurable: true })
const filtered = Object.assign(new Error('filtered'), hidden) as Error & { code?: string; errno?: number }
console.log(String(filtered.code), String(filtered.errno))

const tag: unique symbol = Symbol('tag')
interface Tagged {
  [tag]: number
  code: string
}
const tagged: Tagged = { [tag]: 7, code: 'ETAG' }
const symbolic = Object.assign(new Error('symbolic'), tagged)
console.log(symbolic.code, String(symbolic[tag]))

interface Hiding {
  readonly first: number
  code: string
}
const hiding: Hiding = {
  get first() {
    Object.defineProperty(hiding, 'code', { value: 'EHIDE', writable: true, enumerable: false, configurable: true })
    return 1
  },
  code: 'EHIDE'
}
const rechecked = Object.assign(new Error('rechecked'), hiding) as Error & { first?: number; code?: string }
console.log(String(rechecked.first), 'code' in rechecked)

interface Late {
  readonly first: number
  [tag]?: number
}
const late: Late = {
  get first() {
    late[tag] = 7
    return 1
  }
}
const snapshotted = Object.assign(new Error('snapshotted'), late)
console.log(String(snapshotted.first), String(snapshotted[tag]))
//! expect: Request aborted ECONNABORTED
//! expect: EISDIR, read EISDIR -21 true
//! expect: none
//! expect: ENOENT open
//! expect: undefined EPIPE
//! expect: undefined 7
//! expect: ETAG 7
//! expect: 1 false
//! expect: 1 undefined
export {}
