//! expect-refusal: "Object.create" was passed a prototype carried as
//! expect-refusal: only the null-prototype form renders
// `@hono/node-server`'s `requestPrototype`: an object literal annotated
// `Record<string | symbol, any>` whose accessor and symbol-keyed method read
// `this[methodKey]`, used as the PROTOTYPE of `Object.create` objects that
// carry the symbol-keyed state. The literal's layout refuses the index
// annotation (it would strand the getter body), so `this` inside its members
// must read the literal's own layout, not the annotation -- and the instances
// created from it hold the keys the accessors read.
const methodKey = Symbol('method')
const seal = Symbol('seal')
const proto: Record<string | symbol, any> = {
  get method() {
    return this[methodKey]
  },
  [seal]() {
    return this[methodKey]
  }
}
const req = Object.create(proto)
req[methodKey] = 'GET'
console.log(req.method)
console.log(req[seal]())

// WHY THIS PINS A REFUSAL RATHER THAN AN ANSWER.
//
// Two routes exist for this program. The first is substrate support: give the
// backend a dynamic object whose `[[Prototype]]` is another dynamic object, so
// `Object.create(proto)` and `Object.defineProperty` lay out as a class-like
// family. Nothing in the representation lattice is close to that today -- every
// dynamic object this runtime builds starts with a null `[[Prototype]]`, and
// the accessor bodies on the literal have no receiver layout to bind to. The
// second is a SOURCE ADAPTER, which is the route taken: `scripts/build.mjs`
// rewrites the prototype surgery into `class LightRequest extends Request`,
// the construct the language already has for exactly this object graph, and
// `lazy-subclass-accessor-override.ts` pins the shape that replaced it.
//
// So this file states the gap by NAME instead of asserting a capability that
// was deliberately not built: if `Object.create` ever learns a non-null
// prototype, this program stops refusing and the runner says so.
