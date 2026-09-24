//! dynamic-fallback
//! expect: string req-1 reqId
//! expect: symbol 0 1
//! expect: number 7 3
// fastify's child-logger bindings, find-my-way's constraint notes and pino's
// error key: a computed key whose type states no domain, converted by
// ToPropertyKey at run time.
const kLabel = Symbol('label')
function bindingsOf(context, value) {
  return { [context.server[kLabel].name]: value }
}
const context = { server: { [kLabel]: { name: 'reqId' } } }
const byString = bindingsOf(context, 'req-1')
console.log('string', byString.reqId, Object.keys(byString).join(','))
const marker = Symbol('marker')
const bySymbol = bindingsOf({ server: { [kLabel]: { name: marker } } }, 1)
console.log('symbol', Object.keys(bySymbol).length, bySymbol[marker])
const byNumber = bindingsOf({ server: { [kLabel]: { name: 3 } } }, 7)
console.log('number', byNumber['3'], Object.keys(byNumber).join(','))
