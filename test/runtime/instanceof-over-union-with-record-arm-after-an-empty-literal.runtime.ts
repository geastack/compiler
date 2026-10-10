// `init instanceof HeaderBag` over `HeaderBag | Record<string, string> |
// [string, string][]`, in a program that also boxes an object holding a
// HeaderBag and reads an `any` back as `{}`.
//
// An HTTP framework's query parser starts from `const results: Record<string, string> |
// Record<string, string[]> = {}`, and that `{}` literal is spelled with the
// same carrier as every `{}`-typed value unboxed out of an `any`. The view
// census keyed what a value may hold by carrier alone, so the literal "held"
// every class the box did, and passed it on into the `Record<string, string>`
// arm: the instance test refused as possibly viewed. An object literal is a
// fresh object, never a class instance; only its members convert anything.
class HeaderBag {
  readonly lines: string[] = []
  constructor(init?: HeaderBag | Record<string, string> | [string, string][]) {
    if (init === undefined) return
    if (init instanceof HeaderBag) {
      for (const line of init.lines) this.lines.push(line)
    } else if (Array.isArray(init)) {
      for (const pair of init) this.lines.push(`${pair[0]}=${pair[1]}`)
    } else {
      for (const key of Object.keys(init)) this.lines.push(`${key}=${init[key] ?? ''}`)
    }
  }
}

class Exchange {
  readonly headers = new HeaderBag({ via: 'box' })
}

interface Loose {
  readonly value: any
  readonly count: number
}
interface Settled {
  readonly value?: {}
  readonly count?: number
}
const boxed: any = new Exchange()
const loose: Loose = { value: boxed, count: 1 }
const settled: Settled = loose
console.log(typeof settled.value)

const parse = (query: string): Record<string, string> => {
  const results: Record<string, string> | Record<string, string[]> = {}
  for (const part of query.split('&')) {
    const [name, value] = part.split('=')
    if (name) (results as Record<string, string>)[name] = value ?? ''
  }
  return results as Record<string, string>
}

console.log(new HeaderBag(parse('a=1&b=2')).lines.join(','))
console.log(new HeaderBag((boxed as Exchange).headers).lines.join(','))
console.log(new HeaderBag([['c', '3']]).lines.join(','))

//! expect: object
//! expect: a=1,b=2
//! expect: via=box
//! expect: c=3
