// An abstract base whose concrete subclasses are handed to a dynamic observer
// (an `any`-typed options bag). An observer holding an instance can walk its
// prototype chain to the abstract base's constructor and construct it, so the
// base counts as allocatable. An `abstract` member installs nothing on the
// prototype, so a lookup on such a base instance misses it and reaches
// `Object.prototype` -- it is not a method with no body. A database driver's
// timeout context is the shape: `timeoutContext.csotEnabled()` through the
// abstract type.

export {}

abstract class TimeoutContext {
  abstract csotEnabled(): boolean
  abstract get budget(): number
  describe(): string {
    return `${this.csotEnabled() ? 'csot' : 'legacy'}:${this.budget}`
  }
}

class CsotContext extends TimeoutContext {
  constructor(readonly timeoutMS: number) {
    super()
  }
  csotEnabled(): boolean {
    return true
  }
  get budget(): number {
    return this.timeoutMS
  }
}

class LegacyContext extends TimeoutContext {
  csotEnabled(): boolean {
    return false
  }
  get budget(): number {
    return 0
  }
}

const observed: any[] = []
function observe(options: any): void {
  observed.push(options)
}

function run(context: TimeoutContext): string {
  observe({ timeoutContext: context })
  return `${context.csotEnabled()}|${context.describe()}`
}

console.log(run(new CsotContext(250)))
console.log(run(new LegacyContext()))
console.log(observed.length)
//! expect: true|csot:250
//! expect: false|legacy:0
//! expect: 2
