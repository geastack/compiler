// @ts-nocheck
//! expect: 1 2 1
//! expect: 0 1 true
//! expect: set yy 5
//! expect: set 1 6
// three's TSLCore fills one `{}` with two kinds of accessor-pair literal:
// `proto[ property ] = proto[ alt ] = { get() { ... }, set( value ) { ... } }`
// per swizzle name, then `proto[ i ] = { get() { ... }, set( value ) { ... } }`
// per array index. Both read `this`, so each is a record of its own, while
// the bag's index slot holds the first one's type: the second store has to
// build the slot's record, not a second record converted into it.
const proto = {}
function setSwizzle(property, alt) {
  proto[property] = proto[alt] = {
    get() {
      this.count = (this.count || 0) + 1
      return property.length
    },
    set(value) {
      console.log('set ' + property + ' ' + value)
    }
  }
}
setSwizzle('x', 'r')
setSwizzle('yy', 'gg')
for (let i = 0; i < 2; i++) {
  proto[i] = {
    get() {
      this.count = (this.count || 0) + 1
      return i
    },
    set(value) {
      console.log('set ' + i + ' ' + value)
    }
  }
}
console.log(proto.x.get() + ' ' + proto.gg.get() + ' ' + proto.yy.count)
console.log(proto[0].get() + ' ' + proto[1].get() + ' ' + (proto.x === proto.r))
proto.yy.set(5)
proto[1].set(6)
export {}
