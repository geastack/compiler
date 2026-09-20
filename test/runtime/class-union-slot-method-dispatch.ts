// A slot typed as a union of two unrelated classes that share a method set,
// with calls dispatched through the union: what an interface implemented by
// two classes (hono's `Router<T>`: `RegExpRouter`, `TrieRouter`, held by a
// `SmartRouter`) has to lower to.
class RegexRouter<T> {
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
class TrieRouter<T> {
  name = 'trie'
  #routes: Record<string, T[]> = Object.create(null)
  add(path: string, handler: T): void {
    ;(this.#routes[path] ??= []).push(handler)
  }
  match(path: string): T[] {
    return this.#routes[path] ?? []
  }
}
type AnyRouter<T> = RegexRouter<T> | TrieRouter<T>

class Smart<T> {
  #routers: AnyRouter<T>[]
  constructor(routers: AnyRouter<T>[]) {
    this.#routers = routers
  }
  run(path: string): string[] {
    const names: string[] = []
    for (const router of this.#routers) {
      router.add('/a', 1 as unknown as T)
      router.add('/b', 2 as unknown as T)
      names.push(router.name + ':' + String(router.match(path).length))
    }
    return names
  }
}

const smart = new Smart<number>([new RegexRouter<number>(), new TrieRouter<number>()])
console.log(smart.run('/a').join(' '))
console.log(smart.run('/c').join(' '))
//! expect: regex:1 trie:1
//! expect: regex:0 trie:0
