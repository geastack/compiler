// A Node HTTP adapter's lightweight response class keeps its cached
// status/body/headers under a module-private symbol it never declares on the
// class: the constructor writes `(this as any)[cacheKey] = [...]`, methods read
// it back through an interface cast, `delete` it, and memoize a second symbol
// with `||=`. The listener then asks `cacheKey in res` on a receiver typed as
// the BASE class. The key must stay absent until written and absent again
// after the delete, exactly as an expando would be.
const responseCache = Symbol('responseCache')
const cacheKey = Symbol('cache')

type InternalCache = [number, string | null, Record<string, string> | undefined]

interface LightResponse {
  [responseCache]?: Full
  [cacheKey]?: InternalCache
}

class Full {
  constructor(
    readonly body: string | null,
    readonly status: number
  ) {}
}

class Base {
  kind = 'base'
}

class Light extends Base {
  #body: string | null
  #status: number

  constructor(body: string | null, status: number, cacheable: boolean) {
    super()
    this.#body = body
    this.#status = status
    if (cacheable) (this as any)[cacheKey] = [status || 200, body ?? null, undefined]
  }

  full(): Full {
    delete (this as LightResponse)[cacheKey]
    return ((this as LightResponse)[responseCache] ||= new Full(this.#body, this.#status))
  }

  get status(): number {
    return ((this as LightResponse)[cacheKey] as InternalCache | undefined)?.[0] ?? this.full().status
  }
}

const respond = (res: Base): string => {
  if (!(cacheKey in res)) return 'slow'
  const [status, body] = (res as any)[cacheKey] as InternalCache
  return `fast:${status}:${body}`
}

const fast = new Light('hi', 201, true)
const slow = new Light('lo', 404, false)

//! expect: fast:201:hi slow:404 201 true false
console.log(`${respond(fast)} ${respond(slow)}:${slow.status} ${fast.status} ${cacheKey in fast} ${responseCache in fast}`)

const first = fast.full()
//! expect: slow:201 false true true
console.log(`${respond(fast)}:${fast.status} ${cacheKey in fast} ${responseCache in fast} ${fast.full() === first}`)
