// @ts-nocheck
//! dynamic-fallback
//! expect: hi from x! true true false
// `util.inherits(F, CompiledClass)` links F.prototype to the compiled class's
// prototype; an F instance is an instance of that class (13.10.2). The class
// arrives as a dynamic value, as a `require`d module export does.
class Base {
  hello() { return 'hi' }
}
class Other {}
/**
 * @param {any} ctor
 * @param {any} superCtor
 */
function link(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
}
function Named(name) { this.name = name }
const exported = JSON.parse('{}')
exported.Base = Base
link(Named, exported.Base)
Named.prototype.shout = function () { return this.hello() + ' from ' + this.name + '!' }
const n = new Named('x')
console.log(n.shout(), n instanceof Base, n instanceof Named, n instanceof Other)
