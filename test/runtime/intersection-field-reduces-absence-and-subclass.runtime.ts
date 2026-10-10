// A property two intersection members both constrain reduces the way the
// language reduces it:
//  - `undefined & (number | undefined)` is `undefined` (one member says the
//    key holds nothing, as a database client's `resolveTimeoutOptions` result does);
//  - `Derived & Base` for a class and its ancestor is `Derived` (a database client's
//    `CursorTimeoutContext & TimeoutContext`).
// Both used to refuse the whole intersection carrier.
class Base {
  name(): string {
    return 'base'
  }
}
class Derived extends Base {
  override name(): string {
    return 'derived'
  }
  extra(): number {
    return 7
  }
}
interface Wide {
  limit?: number
  context?: Base
  label: string
}
interface Narrow {
  limit?: undefined
  context?: Derived
}
function merge<T extends Narrow>(options: T): T & Wide {
  return Object.assign({ label: 'merged' }, options)
}
const merged = merge({ context: new Derived() })
console.log(merged.label, merged.limit === undefined, merged.context?.name(), merged.context?.extra())
const empty = merge({})
console.log(empty.label, empty.context === undefined, 'limit' in empty)
//! expect: merged true derived 7
//! expect: merged true false
export {}
