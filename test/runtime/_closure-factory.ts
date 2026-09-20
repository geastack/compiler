// Helper for `closure-factory-export-never-read.ts`: a factory whose call only
// returns a closure over its argument, like hono's `defineWebSocketHelper`.
export class Session {
  #init: { readonly name: string }
  constructor(init: { readonly name: string }) {
    this.#init = init
  }
  get name(): string {
    return this.#init.name
  }
}

export const defineHelper = (handler: (session: Session) => string): ((name: string) => string) => {
  return ((name: string) => handler(new Session({ name }))) as (name: string) => string
}
