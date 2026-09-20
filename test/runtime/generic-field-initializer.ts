//! expect: {"hello":"world"}

// A generic FIELD whose declared type is a generic interface and whose value is
// a generic arrow -- hono's `json: JSONRespond = <T, U>(object: T, ...) => ...`
// (`context.ts`). The call site resolves against the INTERFACE's signature, so
// nothing reaches the arrow's own type parameter: the arrow was a generic with
// no instantiations, `census.ts` walked it not at all, and the field's
// initializer emitted a body with no value at all in a function whose
// convention returns a callable. The field was never initialized, and nothing
// said so -- hono's `c.json` was dead in every program until clang rejected the
// valueless `return`.
interface Respond {
  <T extends object, U extends number = number>(value: T, flag?: U): string
  <T extends object, U extends number = number>(value: T, init?: U): string
}

class Box {
  respond: Respond = <T extends object, U extends number = number>(value: T, arg?: U): string => {
    if (typeof arg === 'number') return 'numbered'
    return JSON.stringify(value)
  }
}

const box = new Box()
console.log(box.respond({ hello: 'world' }))
