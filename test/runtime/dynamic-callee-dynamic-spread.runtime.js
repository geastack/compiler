//! dynamic-fallback
//! expect: 2 3 0
// @fastify/error's `return new FastifyError(...args)` and pino's forwarding
// calls: a spread of a boxed value through a callee the program carries as a
// box. The spread's source is drained through the iterator protocol into the
// one packed argument list a dynamic call takes.
'use strict'
function F (...args) {
  if (!new.target) return new F(...args)
  this.n = args.length
}
F.prototype.kind = 'f'
const three = JSON.parse('[1,2,3]')
const none = JSON.parse('[]')
console.log(new F(1, 2).n, F(...three).n, F(...none).n)
