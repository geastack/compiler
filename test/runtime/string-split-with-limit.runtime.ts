//! expect: 0 a a|b|c a|b|c|d a|b|c|d 0 0 a|. 1 a|b|c|d x
// String.prototype.split with a limit (ECMA-262 22.1.3.21): ToUint32 of the
// limit, zero answering [], an undefined limit meaning 2^32 - 1, and the
// empty separator cut per code unit -- fastify's `this.host.split(':', 1)`.
const s = 'a.b.c.d'
const lim: number | undefined = s.length > 100 ? 1 : undefined
const out = [
  s.split('.', 0).length, s.split('.', 1).join('|'), s.split('.', 3).join('|'), s.split('.', 10).join('|'),
  s.split('.', -1).join('|'), s.split('.', NaN).length, s.split('.', 4294967296).length, s.split('', 2).join('|'),
  ''.split('.', 2).length, s.split('.', lim).join('|'), 'x'.split('', 5).join('|')
]
console.log(out.join(' '))
