// 13.15.3: `-`, `*`, `/`, `%` and `**` ToNumeric both operands, left first,
// and apply the Number operator. A sparse-bitfield package (a database-client
// dependency via its string normalizer) computes `this.pages.length * this.pageSize` off an untyped
// `opts`, so both operands are `any`.

function Pager(opts) {
  if (!opts) opts = {}
  this.pageSize = opts.pageSize || 1024
  this.pages = opts.pages || { length: 2 }
  this.byteLength = this.pages.length * this.pageSize
  this.half = this.byteLength / opts.divisor
  this.rest = opts.count % opts.modulus
}

var p = new Pager({ pageSize: '8', divisor: 4, count: 7, modulus: 3 })
//! expect: bytes=16 half=4 rest=1
console.log('bytes=' + p.byteLength + ' half=' + p.half + ' rest=' + p.rest)

/**
 * @param {any} a
 * @param {any} b
 */
function product(a, b) {
  var n = a * b
  return n
}
//! expect: product=21 NaN 3
console.log('product=' + product('3', 7) + ' ' + product({}, 2) + ' ' + product(JSON.parse('"1.5"'), JSON.parse('2')))

var parsed = JSON.parse('{"a":"9","b":4}')
//! expect: parsed=5 2.25 1 6561
console.log('parsed=' + (parsed.a - parsed.b) + ' ' + parsed.a / parsed.b + ' ' + (parsed.a % parsed.b) + ' ' + parsed.a ** parsed.b)
