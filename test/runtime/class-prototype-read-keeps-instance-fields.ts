//! expect: keys bias,scale 11
//! expect: in true true
// Reading `C.prototype` materializes a native object of C's own layout with
// every field absent. While nothing deleted a field, presence bits were one
// `static` per struct, so clearing them for the prototype cleared them for
// every instance: `Object.keys(instance)` came back empty.
class Base {
  bias = 10
  scale = 2
  hook(delta: number): number {
    return this.bias + delta
  }
}
const saved = Base.prototype.hook
const instance = new Base()
console.log('keys', Object.keys(instance).join(','), saved.call(instance, 1))
console.log('in', 'bias' in instance, 'scale' in instance)
