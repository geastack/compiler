// A spread between two records nothing reads reflectively copies through the
// site's static per-field copy, with the order learned from the source's
// presence bits: neither record carries the Value-based property protocol,
// and the copy still enumerates in the source's creation order, not the
// receiver's layout order. A database client's `{ ...options, ...cursorOptions }` is
// this copy, and reading it as a dynamic one published the options record to
// full reflection.
interface Options {
  a?: number
  b?: string
  c?: boolean
}

interface Narrow {
  a?: number
  c?: boolean
}

function build(late: boolean): Options {
  const options: Options = {}
  if (late) {
    options.c = true
    options.a = 1
  } else {
    options.a = 1
    options.c = true
  }
  options.b = 'x'
  return options
}

const late: Options = { ...build(true) }
const early: Options = { ...build(false) }
console.log(Object.keys(late).join(','), Object.keys(early).join(','))
const narrow: Narrow = { ...build(true), a: 2 }
console.log(Object.keys(narrow).join(','), narrow.a, narrow.c)
//! expect: c,a,b a,c,b
//! expect: c,a,b 2 true
export {}
