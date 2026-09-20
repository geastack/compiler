// A SCRIPT'S GLOBAL `var` HOLDING A CLASS, REASSIGNED TO A SUBCLASS.
//
// The plain-assignment twin of
// `global-var-constructor-redefined-through-global-object.ts`: a later
// `new Endpoint(...)` constructs whichever class the cell holds by then.

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
  if (Endpoint !== Light) {
    Endpoint = Light
  }
}
install()

//! expect: after=light:/b
console.log('after=' + describeNew('/b'))

//! expect: through-global=light:/c
console.log('through-global=' + new Endpoint('/c').describe())

//! expect: same=true
console.log('same=' + (Endpoint === Light))
