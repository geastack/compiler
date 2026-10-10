// An HTTP framework's `SmartRouter.match` picks the first
// router that accepts every route, then replaces ITSELF on the instance:
//
//   this.match = router.match.bind(router)
//
// so every later request calls a bound interface method through the field.
// `router` is a `Router<T>` -- an interface over several router classes -- so
// the bound function is a dispatch over that family, not one known body.
interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): [T, number][]
}

class UnsupportedPathError extends Error {}

class ListRouter<T> implements Router<T> {
  name = 'ListRouter'
  #routes: [string, string, T][] = []
  add(method: string, path: string, handler: T): void {
    if (path.includes('*')) throw new UnsupportedPathError()
    this.#routes.push([method, path, handler])
  }
  match(method: string, path: string): [T, number][] {
    const found: [T, number][] = []
    for (const [m, p, h] of this.#routes) if (m === method && p === path) found.push([h, found.length])
    return found
  }
}

class PrefixRouter<T> implements Router<T> {
  name = 'PrefixRouter'
  #routes: [string, string, T][] = []
  add(method: string, path: string, handler: T): void {
    this.#routes.push([method, path.replace('*', ''), handler])
  }
  match(method: string, path: string): [T, number][] {
    const found: [T, number][] = []
    for (const [m, p, h] of this.#routes) if (m === method && path.startsWith(p)) found.push([h, found.length])
    return found
  }
}

class SmartRouter<T> implements Router<T> {
  name = 'SmartRouter'
  #routers: Router<T>[]
  #routes?: [string, string, T][] = []

  constructor(routers: Router<T>[]) {
    this.#routers = routers
  }

  add(method: string, path: string, handler: T): void {
    if (!this.#routes) throw new Error('already built')
    this.#routes.push([method, path, handler])
  }

  match(method: string, path: string): [T, number][] {
    const routes = this.#routes
    if (!routes) throw new Error('Fatal error')
    for (const router of this.#routers) {
      let res: [T, number][]
      try {
        for (const route of routes) router.add(...route)
        res = router.match(method, path)
      } catch (e) {
        if (e instanceof UnsupportedPathError) continue
        throw e
      }
      this.match = router.match.bind(router)
      this.#routers = [router]
      this.#routes = undefined
      this.name = `SmartRouter + ${router.name}`
      return res
    }
    throw new Error('Fatal error')
  }
}

const describe = (router: Router<string>, path: string): string =>
  router
    .match('GET', path)
    .map(([handler, index]) => `${handler}@${index}`)
    .join(',') || '-'

const exact: Router<string> = new SmartRouter<string>([new ListRouter(), new PrefixRouter()])
exact.add('GET', '/', 'root')
exact.add('GET', '/json', 'json')
const wild: Router<string> = new SmartRouter<string>([new ListRouter(), new PrefixRouter()])
wild.add('GET', '/static/*', 'static')
wild.add('GET', '/', 'root')

//! expect: root@0 json@0 - SmartRouter + ListRouter
console.log(`${describe(exact, '/')} ${describe(exact, '/json')} ${describe(exact, '/nope')} ${exact.name}`)
//! expect: static@0,root@1 root@0 static@0,root@1 SmartRouter + PrefixRouter
console.log(`${describe(wild, '/static/a.css')} ${describe(wild, '/')} ${describe(wild, '/static/b')} ${wild.name}`)
