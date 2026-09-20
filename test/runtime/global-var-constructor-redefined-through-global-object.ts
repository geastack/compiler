// A SCRIPT'S GLOBAL `var` HOLDING A CLASS, REPLACED THROUGH THE GLOBAL OBJECT.
//
// `@hono/node-server`'s `getRequestListener` swaps the platform's `Request`
// for its own subclass with `Object.defineProperty(global, 'Request', {
// value: LightweightRequest })`, and every later `new Request(...)` anywhere
// in the program constructs the subclass. A script-level `var` is an own,
// writable, non-configurable data property of the global object (ECMA-262
// 9.1.1.4.17), so ValidateAndApplyPropertyDescriptor lets a `value`-only
// descriptor replace its value: the redefinition is a write to the var's
// cell, and every read after it -- bare or through `globalThis` -- sees the
// new class.

class Platform {
  constructor(readonly url: string) {}
  describe(): string {
    return 'platform:' + this.url
  }
}

var Endpoint: typeof Platform = Platform

class Light extends Platform {
  override describe(): string {
    return 'light:' + this.url
  }
}

const describeNew = (url: string): string => new Endpoint(url).describe()

//! expect: before=platform:/a
console.log('before=' + describeNew('/a'))

const install = (): void => {
  if (globalThis.Endpoint !== Light) {
    Object.defineProperty(globalThis, 'Endpoint', { value: Light })
  }
}
install()

//! expect: after=light:/b
console.log('after=' + describeNew('/b'))

//! expect: through-global=light:/c
console.log('through-global=' + new globalThis.Endpoint('/c').describe())

//! expect: same=true
console.log('same=' + (Endpoint === Light))
