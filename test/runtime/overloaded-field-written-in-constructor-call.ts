//! expect: get:/a
//! expect: post:/b:2

// hono's `HonoBase`: `get!: HandlerInterface<...>` is annotated with an
// interface of many overloads that join into no single convention, and the one
// function that ever lives in the cell is written by the constructor's
// `allMethods.forEach((method) => { this[method] = (args1, ...args) => {...} })`.
// `overloaded-callable-fields.ts` is the same shape whose overloads happen to
// join; this is the case where they do not, which is what left
// `app.get('/', handler)` with a `callable-identity` callee and no invoke path.

interface RouteInit {
  weight: number
}

interface Register {
  (path: string): string
  (path: string, init: RouteInit): string
  (init: RouteInit, path: string): string
}

class Registry {
  get!: Register
  post!: Register

  constructor() {
    const methods = ['get', 'post'] as const
    methods.forEach((method) => {
      this[method] = (first: string | RouteInit, second?: string | RouteInit): string => {
        const path = typeof first === 'string' ? first : typeof second === 'string' ? second : '?'
        const init = typeof first === 'string' ? second : first
        const weight = init !== undefined && typeof init !== 'string' ? `:${init.weight}` : ''
        return `${method}:${path}${weight}`
      }
    })
  }
}

const registry = new Registry()
console.log(registry.get('/a'))
console.log(registry.post('/b', { weight: 2 }))
