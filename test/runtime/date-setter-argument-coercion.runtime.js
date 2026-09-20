// @ts-nocheck
// A Date setter applies ToNumber to each argument IN ORDER, through the
// argument's own `valueOf` (ECMA-262 21.4.4.23 steps 2..5), before the time
// value changes; an argument past the last the clause names is never
// coerced; a `valueOf` answering undefined is NaN -- the shape of test262's
// `built-ins/Date/prototype/set*/arg-*-to-number{,-err}.js` and
// `arg-coercion-order.js`.
//! expect: h,m,s,ms 3723004
//! expect: true 4 3723004
//! expect: NaN NaN 0
var date = new Date(0)
var effects = []
var mk = function (name, v) {
  return {
    valueOf: function () {
      effects.push(name)
      return v
    }
  }
}
var counter = {
  valueOf: function () {
    effects.push('counter')
  }
}
var thrower = {
  valueOf: function () {
    throw 'boom'
  }
}
date.setUTCHours(mk('h', 1), mk('m', 2), mk('s', 3), mk('ms', 4))
console.log(effects.join(','), date.getTime())
var caught = false
try {
  date.setMinutes(0, 0, thrower, counter)
} catch (e) {
  caught = e === 'boom'
}
console.log(caught, effects.length, date.getTime())
var d2 = new Date(0)
console.log(d2.setUTCSeconds(counter), Number.NaN, Date.prototype.toLocaleDateString.length)
