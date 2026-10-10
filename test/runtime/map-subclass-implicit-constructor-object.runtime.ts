// A class with no constructor of its own, extending `Map`: its constructor
// object inherits Map's two ambient construct overloads, and reading the
// class as a VALUE (`Lower.prototype.normalize.call(...)`, as
// a connection-string parser's case-insensitive map does) needs one
// calling convention for it.
class Lower<K extends string = string> extends Map<K, string> {
  normalize(name: K): string {
    return name.toLowerCase()
  }
}
const lower = new Lower<string>()
lower.set('A', 'x')
lower.set('B', 'y')
console.log(lower.size, Lower.prototype.normalize.call(lower, 'Q'), lower.get('A'))
//! expect: 2 q x
