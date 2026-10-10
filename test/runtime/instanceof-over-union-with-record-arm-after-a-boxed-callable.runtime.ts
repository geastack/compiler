// `init instanceof HeaderBag` over `HeaderBag | Record<string, string> |
// [string, string][]` -- node-compat's `Headers` constructor again, now in a
// program that BOXES a callable whose parameter reaches a HeaderBag (a framework's
// middleware handed to an `any` slot: `(c: Context, next) => ...`).
//
// Boxing a callable boxes the callable, not the classes its parameters name:
// a caller of the box passes boxed arguments IN, unboxed into the parameter
// carriers, and the result comes OUT boxed. The view census read the boxing
// as a whole-carrier conversion instead, so every class the parameter types
// reached "was" boxed, and from the box reached every record the program
// unboxes an `any` into -- including the `Record<string, string>` arm, and the
// instance test refused as possibly viewed.
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

const middleware = (exchange: Exchange, next: () => number): number => exchange.headers.lines.length + next()
const registry: any[] = []
registry.push(middleware)

// An `any` unboxed into a record keeps whatever view the box held, and that
// record read as a dictionary keeps it too: so a HeaderBag that really WAS
// boxed would reach the `Record<string, string>` arm. Only one that was not
// must not.
const loose: any = JSON.parse('{"k":"v"}')
const shaped: { k?: string } = loose
const table = shaped as Record<string, string>

// Some HeaderBag IS viewed as a record elsewhere, so the census has to ask
// which carriers can hold that view rather than answering "none anywhere".
const view: { readonly lines: readonly string[] } = new HeaderBag({ seen: 'view' })
console.log(view.lines.join(','))
console.log(new HeaderBag(new Exchange().headers).lines.join(','))
console.log(new HeaderBag(table).lines.join(','))
console.log(new HeaderBag([['a', '1']]).lines.join(','))
console.log(String(registry.length))

//! expect: seen=view
//! expect: via=box
//! expect: k=v
//! expect: a=1
//! expect: 1
