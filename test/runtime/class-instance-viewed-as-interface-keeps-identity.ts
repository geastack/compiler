// A CLASS INSTANCE PASSED WHERE AN INTERFACE IS DECLARED STAYS ITS CLASS.
//
// Hono builds `new Response(null, response)` -- a Response where `ResponseInit`
// is declared -- and `@hono/node-server`'s constructor asks `init instanceof
// GlobalResponse`, then reads the init as a Response. The interface value is a
// structural view of the instance; `instanceof` and the narrowing must still
// answer from the instance it was built from, and a view of a plain record
// must not pass.

interface Init {
  status?: number
  statusText?: string
}

class Reply {
  #status: number
  #statusText: string
  #copied: boolean

  constructor(init?: Init) {
    if (init instanceof Reply) {
      this.#status = init.status
      this.#statusText = init.statusText
      this.#copied = init.#copied || true
      return
    }
    this.#status = init?.status ?? 200
    this.#statusText = init?.statusText ?? 'OK'
    this.#copied = false
  }

  get status(): number {
    return this.#status
  }

  get statusText(): string {
    return this.#statusText
  }

  get copied(): boolean {
    return this.#copied
  }
}

const original = new Reply({ status: 201, statusText: 'Created' })
const copy = new Reply(original)
const plain = new Reply({ status: 404, statusText: 'Not Found' })

//! expect: copy=201 Created true
console.log(`copy=${copy.status} ${copy.statusText} ${copy.copied}`)

//! expect: plain=404 Not Found false
console.log(`plain=${plain.status} ${plain.statusText} ${plain.copied}`)

const describe = (init: Init): string => (init instanceof Reply ? 'reply' : 'record')

//! expect: kinds=reply record
console.log(`kinds=${describe(original)} ${describe({ status: 1 })}`)
