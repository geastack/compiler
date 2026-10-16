// An HTTP framework's request wrapper caches parsed bodies in a cache it holds dynamically and
// reads back with `bodyCache[key]` for `key: keyof Body`. A computed read on an
// unknown receiver can name any class's method, but this key is a proven
// finite set, and only members of those names can answer it. Filed as an
// unknown key, the read kept every method of every constructed class --
// the request's `query` and the query-string parser nothing calls among them.
export {}

type BodyKey = 'json' | 'text'

class Unrelated {
  label = 'unrelated'
  never(): string {
    return 'unreachable-method-body'
  }
}

class Req {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyCache: any = {}
  read(key: BodyKey): unknown {
    const cached = this.bodyCache[key]
    if (cached) return cached
    return (this.bodyCache[key] = `parsed ${key}`)
  }
}

const request = new Req()
const unrelated = new Unrelated()
console.log(request.read('text'), request.read('text'), unrelated.label)
//! expect: parsed text parsed text unrelated
//! emitted-lacks: unreachable-method-body
