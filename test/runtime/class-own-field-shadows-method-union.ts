// hono's `SmartRouter.match` memoises its choice by OVERWRITING its own method
// slot: `this.match = router.match.bind(router)`. That makes `match` both a
// prototype method and an own field, so a read of it off the `Router<T>` union
// reaches the own-shadow branch -- whose slot carries the method's storage
// convention (receiver first) while the union publishes a receiver-less
// callable. The two conventions had no conversion between them.
//! expect: alpha:x
//! expect: relay>alpha:x
//! expect: alpha:y
//! expect: alpha:z
//! expect: gamma:x
//! expect: shadow:y
interface Probe {
  readonly name: string
  probe(a: string): string
}

class Alpha implements Probe {
  name = 'alpha'
  probe(a: string): string {
    return `${this.name}:${a}`
  }
}

class Relay implements Probe {
  name = 'relay'
  #inner: Probe

  constructor(inner: Probe) {
    this.#inner = inner
  }

  probe(a: string): string {
    const inner = this.#inner
    const answered = inner.probe(a)
    // The own shadow: after the first call the relay answers directly.
    this.probe = inner.probe.bind(inner)
    return `relay>${answered}`
  }
}

// The same shadow written with a value that is not a method at all: before
// the union's deferred-method claim asked about own shadows it called the
// declared body straight off the tag and answered `gamma:y` here, which is a
// wrong answer rather than a refusal.
class Gamma implements Probe {
  name = 'gamma'
  probe(a: string): string {
    this.probe = (b: string): string => `shadow:${b}`
    return `${this.name}:${a}`
  }
}

const alpha = new Alpha()
const relay: Probe = new Relay(alpha)
console.log(alpha.probe('x'))
console.log(relay.probe('x'))
console.log(relay.probe('y'))
const detached = relay.probe.bind(relay)
console.log(detached('z'))

const gamma: Probe = new Gamma()
console.log(gamma.probe('x'))
console.log(gamma.probe('y'))
