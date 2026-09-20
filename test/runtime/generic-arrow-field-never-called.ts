// hono's `Context.redirect`: a class field initialized with a GENERIC arrow
// (`<T extends RedirectStatusCode = 302>(location, status?) => ...`) that the
// program never calls. The specialization census has no copy of it and the
// census walks it not at all, so the field must be recorded as one with no
// initializer: the class still constructs, and its other members still run.
// (Minting an initializer thunk over the unwalked body made every `new`
// throw the `never` trap the empty return became.)
class Context {
  #status = 200
  finalized = false
  redirect = <T extends number = 302>(location: string, status?: T): string => {
    return `${status ?? 302} ${location}`
  }
  text = (body: string): string => `${this.#status} ${body}`
  status(code: number): void {
    this.#status = code
  }
}
const c = new Context()
c.status(201)
console.log(c.text('created'))
console.log(c.finalized)
//! expect: 201 created
//! expect: false
