// @ts-nocheck
function F() {}
F.prototype = {
  m() {
    return 1
  }
}
F.prototype.n = function () {
  return 2
}
var o = new F()
console.log(o.m(), o.n(), Object.getPrototypeOf(o) === F.prototype, o instanceof F)
function G(v) {
  this.v = v
}
G.prototype.get = function () {
  return this.v
}
var g = new G(3)
console.log(g.get(), 'get' in g, Object.prototype.hasOwnProperty.call(g, 'get'))
var proto = {
  greet() {
    return 'hello'
  }
}
function H() {}
H.prototype = proto
var h = new H()
h.x = 4
console.log(h.greet(), h.x)
