//! expect: ax true bx 2
// `new Map()`'s zero-argument overload is `Map<any, any>`, which states
// nothing; stored straight into a declared slot, the allocation is that
// slot's map. ajv's `vs = this._values[prefix] = new Map()`.
class ScopeName {
  readonly str: string
  constructor(str: string) {
    this.str = str
  }
}
type ScopeValues = { [prefix: string]: Map<unknown, ScopeName> | undefined }
class ValueScope {
  protected readonly _values: ScopeValues = {}
  value(prefix: string, key: string): ScopeName {
    let vs = this._values[prefix]
    if (vs) {
      const found = vs.get(key)
      if (found) return found
    } else {
      vs = this._values[prefix] = new Map()
    }
    const name = new ScopeName(prefix + key)
    vs.set(key, name)
    return name
  }
  size(prefix: string): number {
    return this._values[prefix]?.size ?? 0
  }
}
const scope = new ValueScope()
const first = scope.value('a', 'x')
scope.value('b', 'x')
scope.value('b', 'y')
console.log(first.str, scope.value('a', 'x') === first, scope.value('b', 'x').str, scope.size('b'))
