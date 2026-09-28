// @ts-nocheck
//! dynamic-fallback
//! expect: tree:e ready resolved:7 null true
// A JavaScript object literal member initialized with `null` and filled later
// holds what the program writes into it, not the initializer's own `null`:
// fastify's `printPlugins: null` receives a bound method, avvio's
// `{ resolve: null }` receives a promise's resolver, and a member nothing ever
// writes again stays `null`.
function make (engine) {
  const app = { name: 'x', printPlugins: null, onReady: null, spare: null }
  app.printPlugins = engine.pretty.bind(engine)
  app.onReady = () => 'ready'
  return app
}
function createPromise () {
  const obj = { resolve: null, reject: null, promise: null }
  obj.promise = new Promise((resolve, reject) => {
    obj.resolve = resolve
    obj.reject = reject
  })
  return obj
}
const engine = { tag: 'e', pretty () { return 'tree:' + this.tag } }
const helpers = { make }
const app = helpers[['ma', 'ke'].join('')](engine)
const pending = createPromise()
pending.promise.then((value) => {
  console.log(app.printPlugins(), app.onReady(), 'resolved:' + value, app.spare, typeof pending.reject === 'function')
})
pending.resolve(7)
