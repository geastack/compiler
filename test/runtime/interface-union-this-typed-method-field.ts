// An interface implemented by several constructed classes derives to the
// tagged union of their carriers, and hono's `Router<T>` is one: `RegExpRouter`
// declares `match` as a FIELD holding a free function whose `this` parameter is
// the interface itself (`match: typeof match<Router<T>, T> = match`), while the
// trie and smart routers declare it as an ordinary method. So one arm stores a
// callable whose ABI names a receiver and the read publishes one that does not
// -- the checker consumed the `this` at the member access -- and there was no
// conversion between the two.
//! expect: alpha:x
//! expect: beta:x
//! expect: gamma:x
//! expect: alpha:bound
interface Probe {
  readonly name: string
  probe(a: string): string
}

function probeImpl<R extends Probe>(this: R, a: string): string {
  return `${this.name}:${a}`
}

class Alpha implements Probe {
  name = 'alpha'
  probe: typeof probeImpl<Probe> = probeImpl
}

class Beta implements Probe {
  name = 'beta'
  probe(a: string): string {
    return `${this.name}:${a}`
  }
}

class Gamma implements Probe {
  name = 'gamma'
  probe(a: string): string {
    return `${this.name}:${a}`
  }
}

const probes: Probe[] = [new Alpha(), new Beta(), new Gamma()]
for (let i = 0; i < probes.length; i++) {
  console.log(probes[i]!.probe('x'))
}

// The `bind` shape `SmartRouter.match` writes: the read is taken as a VALUE
// off the union and re-bound to the same arm.
const first: Probe = probes[0]!
const bound = first.probe.bind(first)
console.log(bound('bound'))
