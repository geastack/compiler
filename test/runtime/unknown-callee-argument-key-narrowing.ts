type Handler = (payload: number[]) => void

// A listener stored in a field and called back out of it. The callee is an
// element of that array, which the reach proof cannot resolve to one body, so
// `handler( payload )` is an UNAUTHENTICATED call and the census reaches its
// argument stamp with `payload` -- whose component touches the Array
// prototype. Stamping `every` there is what used to refuse the two
// obligations below; the program's own writes name no key that reaches them.
class Bus {
  private listeners_: Handler[] = []

  on(handler: Handler): void {
    this.listeners_.push(handler)
  }

  emit(payload: number[]): void {
    for (const handler of this.listeners_) handler(payload)
  }
}

let total = 0
const bus = new Bus()
bus.on((payload) => {
  for (const value of payload) total = total + value
})
bus.emit([1, 2, 3])
console.log(total)
//! expect: 6

// Both obligations the stamp above used to hold: `Object.keys` must be the
// real one, and the array it returns must carry the intrinsic Array prototype
// for `forEach` to be borrowed from it. This is hono's `RegExpRouter.add`
// shape, reduced.
const routes: Record<string, number> = { '/a': 1, '/b': 2 }
let joined = ''
Object.keys(routes).forEach((path) => {
  joined = joined === '' ? path : joined + ',' + path
})
console.log(joined)
//! expect: /a,/b
