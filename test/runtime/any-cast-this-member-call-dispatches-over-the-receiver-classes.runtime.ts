// A regular-expression router installs a free function as its `match` field, and that
// function reaches back into the router through `(this as any)
// .buildAllMatchers()`. Its `this` is whatever `Router<T>` the field was
// called on, so the receiver's carrier is the union of every router class; the
// `as any` only erases the static type, it does not make the receiver
// dynamic. The member call is dispatched over those classes natively -- the
// one that declares the method calls it, any other throws the TypeError a
// missing method throws -- instead of publishing every router's fields to a
// dynamic call.
export {}

interface Router {
  name: string
  match(path: string): string
}

function match<R extends Router>(this: R, path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table: Record<string, string> = (this as any).buildAll()
  return table[path] ?? 'none'
}

class TableRouter implements Router {
  name = 'table'
  #routes: Record<string, string> = { '/a': 'A' }
  match: typeof match<Router> = match
  protected buildAll(): Record<string, string> {
    return this.#routes
  }
}

class ListRouter implements Router {
  name = 'list'
  match(path: string): string {
    return path === '/b' ? 'B' : 'none'
  }
}

// SmartRouter's shape: the first router that answers is bound in place of
// this method, so later matches go straight to it.
class FirstRouter implements Router {
  name = 'first'
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

const routers: Router[] = [new FirstRouter([new ListRouter(), new TableRouter()]), new TableRouter()]
console.log(routers.map((router) => router.match('/a')).join(','), routers[0]!.match('/b'), routers[0]!.match('/a'))
try {
  match.call(new ListRouter(), '/a')
} catch (error) {
  console.log(error instanceof TypeError)
}
//! expect: A,A none A
//! expect: true
//! emitted-lacks: gea::nativeDynamicGet
//! emitted-lacks: gea::Value::boxMethod
