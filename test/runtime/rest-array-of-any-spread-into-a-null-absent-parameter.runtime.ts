// An HTTP framework's Context declares `newResponse = (...args) =>
// this.#newResponse(...(args as Parameters<NewResponse>))`: the rest array is
// `any[]`, and spreading it into the stated frame reads each element into its
// parameter's carrier. The first parameter is `Data | null` -- absent as
// `null`, not as a hole's `undefined` -- so the element converts into the whole
// optional rather than into its payload.
export {}

type Data = string | ArrayBuffer

const describe = (data: Data | null, status?: number): string =>
  `${data === null ? 'null' : typeof data === 'string' ? data : `bytes:${data.byteLength}`}/${status ?? 200}`

type Describe = typeof describe

class Context {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  respond: (...args: any[]) => string = (...args) => describe(...(args as Parameters<Describe>))
}

const c = new Context()
console.log(c.respond('hi', 201), c.respond(null), c.respond(new ArrayBuffer(3), 404))
//! expect: hi/201 null/200 bytes:3/404
