// An interface three classes implement, one of which holds an array of the
// other two behind the interface -- hono's `Router<T>` with `RegExpRouter`,
// `TrieRouter` and the `SmartRouter` that tries them in order. The slot typed
// by the interface is the tagged sum of the implementing classes.
interface Router<T> {
  name: string
  add(path: string, handler: T): void
  match(path: string): T[]
}
class RegexRouter<T> implements Router<T> {
  name = 'regex'
  #routes: [string, T][] = []
  add(path: string, handler: T): void {
    this.#routes.push([path, handler])
  }
  match(path: string): T[] {
    const out: T[] = []
    for (const [p, h] of this.#routes) if (p === path) out.push(h)
    return out
  }
}
class TrieRouter<T> implements Router<T> {
  name = 'trie'
  #routes: Record<string, T[]> = Object.create(null)
  add(path: string, handler: T): void {
    ;(this.#routes[path] ??= []).push(handler)
  }
  match(path: string): T[] {
    return this.#routes[path] ?? []
  }
}
class SmartRouter<T> implements Router<T> {
  name = 'smart'
  #routers: Router<T>[]
  #routes: [string, T][] = []
  constructor(init: { routers: Router<T>[] }) {
    this.#routers = init.routers
  }
  add(path: string, handler: T): void {
    this.#routes.push([path, handler])
  }
  match(path: string): T[] {
    const router = this.#routers[0]!
    for (const [p, h] of this.#routes) router.add(p, h)
    this.#routes = []
    this.name = 'smart(' + router.name + ')'
    return router.match(path)
  }
}
class App {
  router: Router<[string, number]>
  constructor() {
    this.router = new SmartRouter<[string, number]>({ routers: [new RegexRouter(), new TrieRouter()] })
  }
  get(path: string, order: number): void {
    this.router.add(path, [path, order])
  }
  fetch(path: string): string {
    const hits = this.router.match(path)
    return this.router.name + ' ' + hits.map(([p, o]) => p + '#' + String(o)).join(',')
  }
}
const app = new App()
app.get('/', 1)
app.get('/json', 2)
console.log(app.fetch('/json'))
console.log(app.fetch('/'))
console.log(app.fetch('/missing'))
//! expect: smart(regex) /json#2
//! expect: smart(regex) /#1
//! expect: smart(regex) 
