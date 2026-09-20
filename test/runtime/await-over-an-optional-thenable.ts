// `await` OF A VALUE THAT IS EITHER ABSENT, A PROMISE, OR THE PAYLOAD ITSELF.
//
// ECMA-262 27.2.4.7.1 `PromiseResolve` is a per-VALUE test: a thenable is
// adopted and anything else -- `undefined` included -- resolves to itself. So
// `await (Promise<T> | undefined)` is `T | undefined`, and TypeScript says the
// same thing with `Awaited<T>`.
//
// The carrier for such a value is an `Optional` WRAPPER around the thing that
// may be a promise, and that wrapper is the case the await renderer used to
// pass through untouched: it asked only whether the carrier itself was a
// promise or a union of one, so an `Optional<Promise<T>>` reached the result
// cell unresolved and clang refused the store.
//
// Both shapes here are @hono/node-server's own. `responseViaCache` awaits
// `writeFromReadableStream(body, outgoing)?.catch(...)`, which is
// `Promise<undefined> | undefined`; `responseViaResponseObject` awaits
// `options.errorHandler(err)`, whose `CustomErrorHandler` result is
// `Response | Promise<Response | undefined> | undefined` -- an optional over a
// union whose two arms resolve to DIFFERENT carriers (`Response` and
// `Response | undefined`), which is why the absence cannot be answered by the
// union alone.

class Marker {
  readonly label: string
  constructor(label: string) {
    this.label = label
  }
}

const settleNothing = (deferred: boolean): Promise<undefined> | undefined => (deferred ? Promise.resolve(undefined) : undefined)

// Spelled through annotated cells rather than inline: a bare
// `Promise.resolve(new Marker(...))` is a `Promise<Marker>`, which is not the
// union's arm (`Promise<Marker | undefined>` is), and widening one promise
// payload into another is a separate hole this fixture is not about.
const defer = async (marker: Marker | undefined): Promise<Marker | undefined> => marker

const deferredMarker: Promise<Marker | undefined> = defer(new Marker('deferred'))
const deferredAbsentMarker: Promise<Marker | undefined> = defer(undefined)

const settleMarker = (mode: number): Marker | Promise<Marker | undefined> | undefined => {
  if (mode === 0) return new Marker('direct')
  if (mode === 1) return deferredMarker
  if (mode === 2) return deferredAbsentMarker
  return undefined
}

const labelOf = (marker: Marker | undefined): string => (marker === undefined ? 'none' : marker.label)

const run = async (): Promise<string> => {
  const deferredNothing = await settleNothing(true)
  const absentNothing = await settleNothing(false)
  const direct = await settleMarker(0)
  const deferred = await settleMarker(1)
  const deferredAbsent = await settleMarker(2)
  const absent = await settleMarker(3)
  const parts: string[] = [
    deferredNothing === undefined ? 'yes' : 'no',
    absentNothing === undefined ? 'yes' : 'no',
    labelOf(direct),
    labelOf(deferred),
    labelOf(deferredAbsent),
    labelOf(absent)
  ]
  return parts.join('|')
}

//! expect: yes|yes|direct|deferred|none|none
console.log(await run())
