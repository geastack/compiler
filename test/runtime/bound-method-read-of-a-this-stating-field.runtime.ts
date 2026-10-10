// Hono's SmartRouter replaces its own `match` with the first router that
// answers: `this.match = router.match.bind(router)`. One router class holds a
// free `function match(this: R, ...)` in a `match` FIELD, the others declare a
// `match` METHOD, so the read is of a member the program states on every arm,
// and `bind` supplies the receiver the callable is entered with.
export {}

interface Router {
  match(path: string): string
}

function match<R extends Router>(this: R, path: string): string {
  return path === '/a' ? `A:${(this as unknown as TableRouter).name}` : 'none'
}

class TableRouter implements Router {
  name = 'table'
  match: typeof match<Router> = match
}

class ListRouter implements Router {
  match(path: string): string {
    return path === '/b' ? 'B' : 'none'
  }
}

class FirstRouter implements Router {
  constructor(readonly routers: Router[]) {}
  match(path: string): string {
    for (const router of this.routers) {
      const found = router.match(path)
      if (found === 'none') continue
      this.match = router.match.bind(router)
      return found
    }
    return 'none'
  }
}

const first = new FirstRouter([new ListRouter(), new TableRouter()])
console.log(first.match('/a'), first.match('/b'), first.match('/a'))
//! expect: A:table none A:table
