// The imported, generic base of derived-class-imports-generic-base.ts.
export type Handler<T> = (input: T) => string
export class GenericBase<T> {
  #routes: [string, Handler<T>][] = []
  #addRoute(method: string, handler: Handler<T>): void {
    this.#routes.push([method, handler])
  }
  on(method: string, ...handlers: Handler<T>[]): void {
    handlers.forEach((handler) => {
      this.#addRoute(method, handler)
    })
  }
  run(input: T): string {
    return this.#routes.map(([method, handler]) => method + '=' + handler(input)).join(',')
  }
}
