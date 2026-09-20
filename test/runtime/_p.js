/** @param {number} a */
function N(a) {
  this.v = a
}
N.prototype.get = function N_get() {
  return this.v
}
N.make = function N_make() {
  return 5
}
var x = new N(1)
console.log(x.get(), N.make())
