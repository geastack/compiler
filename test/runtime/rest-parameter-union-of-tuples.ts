//! expect: open:/ws 2
//! expect: open:/direct 5
// A rest parameter annotated as a union of tuples -- hono's
// `defineWebSocketHelper` shape (`...args: [createEvents, options?] | [c,
// events, options?]`) -- binds one Array at run time whatever the arms say.
// The ABI published `array-object`, the body binding kept the checker's union
// and derived a tagged-union of positional records, and `projection/abi.ts`
// refused the function for the disagreement.
interface Ctx {
  readonly path: string
}
interface Events {
  readonly onOpen: (c: Ctx) => number
}
type Handler = (c: Ctx, events: Events, options?: number) => number

const defineHelper = (handler: Handler) => {
  return (...args: [createEvents: (c: Ctx) => Events, options?: number] | [c: Ctx, events: Events, options?: number]): number => {
    if (typeof args[0] === 'function') {
      const [createEvents, options] = args as [(c: Ctx) => Events, number?]
      const c: Ctx = { path: '/ws' }
      return handler(c, createEvents(c), options)
    }
    const [c, events, options] = args as [Ctx, Events, number?]
    return handler(c, events, options)
  }
}

const helper = defineHelper((c, events, options) => {
  const n = events.onOpen(c)
  console.log('open:' + c.path, n + (options ?? 0))
  return n
})
helper(() => ({ onOpen: () => 2 }))
helper({ path: '/direct' }, { onOpen: () => 3 }, 2)
