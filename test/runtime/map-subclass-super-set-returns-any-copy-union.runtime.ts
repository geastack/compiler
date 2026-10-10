//! expect: default:a=1
//! expect: urls:b=x,y
//! expect: chained:true
//! expect: has:true
//! expect: objects:3

// A connection-string parser's `CaseInsensitiveMap<Value = any> extends
// Map<string, Value>`: instantiated at `any` (DEFAULT_OPTIONS) and at
// `unknown[]`, the class splits into layout-distinct copies, and the `any`
// copy's `this` is the union of the copies. Its `set` returns `super.set(..)`
// -- the receiver, typed `this` -- so the native-base view the Map helper
// hands back must re-enter that union at the receiver's own copy.

class CaseInsensitiveMap<Value = any> extends Map<string, Value> {
  constructor(entries: Array<[string, any]> = []) {
    super(entries.map(([k, v]) => [k.toLowerCase(), v]))
  }
  override has(k: string) {
    return super.has(k.toLowerCase())
  }
  override get(k: string) {
    return super.get(k.toLowerCase())
  }
  override set(k: string, v: any) {
    return super.set(k.toLowerCase(), v)
  }
}

const defaults = new CaseInsensitiveMap([['A', 1]])
const objects = new CaseInsensitiveMap<unknown>([['D', true]])
const urls = new CaseInsensitiveMap<unknown[]>()
urls.set('B', ['x', 'y'])
const again = defaults.set('C', 2)
console.log('default:a=' + defaults.get('a'))
console.log('urls:b=' + (urls.get('b') ?? []).join(','))
console.log('chained:' + (again === defaults))
console.log('has:' + again.has('c'))
console.log('objects:' + objects.set('E', 3).get('e'))
