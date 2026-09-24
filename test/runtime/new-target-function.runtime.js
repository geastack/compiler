//! dynamic-fallback
//! expect: x:true y:true
//! expect: called undefined
//! expect: nested inner:true outer:true
// avvio's `Boot` and @fastify/error's `FastifyError`: `if (!new.target) return
// new F(...)`. A plain call and a `.call` from another function see
// `undefined`; a construction sees the function, even after constructing
// another reader in between.
function Boot(server) {
  if (!new.target) {
    return new Boot(server)
  }
  this.server = server
  this.constructed = new.target === Boot
}
Boot.prototype.describe = function () {
  return this.server + ':' + this.constructed
}
function Helper(target) {
  Boot.call(target, 'called')
}
function Outer(name) {
  this.inner = new Boot(name)
  this.constructed = new.target === Outer
}
Outer.prototype.describe = function () {
  return 'inner:' + this.inner.constructed + ' outer:' + this.constructed
}
const a = Boot('x')
const b = new Boot('y')
console.log(a.describe(), b.describe())
const c = {}
Helper(c)
console.log('called', c.server)
console.log('nested', new Outer('z').describe())
