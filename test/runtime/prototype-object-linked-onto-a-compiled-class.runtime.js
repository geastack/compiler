// @ts-nocheck
//! dynamic-fallback
//! expect: hello x from greeter
//! expect: hi p kind true
// An object literal with an accessor, re-parented onto a compiled class's
// prototype and instantiated with `Object.create`, the class reached through
// a value as pino reaches `EventEmitter` through `require`: the instances
// inherit the class's methods through its prototype facade.
class Greeter {
  greet (who) { return 'hello ' + who + ' from ' + this.label() }
  label () { return 'greeter' }
}
const prototype = {
  hello () { return 'hi ' + this.name },
  get kind () { return 'kind' }
}
const Linked = Greeter
Object.setPrototypeOf(prototype, Linked.prototype)
const make = function () { return Object.create(prototype) }
const inst = make()
inst.name = 'p'
console.log(inst.greet('x'))
console.log(inst.hello(), inst.kind, inst instanceof Greeter)
