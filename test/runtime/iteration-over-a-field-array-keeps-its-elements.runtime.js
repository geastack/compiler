// @ts-nocheck
//! dynamic-fallback
//! expect: h 5 h 6
//! expect: r 7
// An array stored in an object field is typed `never[]` by the checker when
// its literal is empty; the loop binds the elements the program pushed.
function run () {
  const hooks = { onRoute: [] }
  hooks.onRoute.push(function () { return 5 })
  hooks.onRoute.push(function () { return 6 })
  const out = []
  for (const h of hooks.onRoute) out.push('h ' + h())
  console.log(out.join(' '))
}
run()
const kHooks = Symbol('hooks')
function Instance () { this[kHooks] = { onRoute: [] } }
const app = new Instance()
app[kHooks].onRoute.push(function () { return 7 })
for (const hook of app[kHooks].onRoute) console.log('r', hook())
