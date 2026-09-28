// @ts-nocheck
//! dynamic-fallback
//! expect: false function 7 undefined undefined
// avvio's `Object.defineProperty(server, 'then', { get: thenify.bind(instance) })`:
// a bound function, whose call takes no receiver, is stored where a getter
// (called with the object as `this`) is expected. The bound `this` wins.
function Boot () {
  this.booted = false
  this.value = 7
}
const kDoNotWrap = Symbol('do-not-wrap')
function thenify () {
  if (this.booted) return
  if (this[kDoNotWrap]) {
    this[kDoNotWrap] = false
    return
  }
  return (resolve) => resolve(this.value)
}
function install (server, instance) {
  if (server.then) throw new Error('then already defined')
  Object.defineProperty(server, 'then', { get: thenify.bind(instance) })
}
const instance = new Boot()
const server = { name: 'server' }
install(server, instance)
const bootedBefore = instance.booted
const then = server.then
const wrapped = then((value) => value)
instance[kDoNotWrap] = true
const skipped = server.then
instance.booted = true
console.log(bootedBefore, typeof then, wrapped, skipped, server.then)
