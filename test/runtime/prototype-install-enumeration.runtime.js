// @ts-nocheck
//! expect: for-in x,y,flag,shade
//! expect: shadowed x,y,flag,shade
//! expect: in true true false true
//! expect: own x,y | x,y
// Keys installed on a class prototype are inherited, not own: `for`-`in`
// lists the enumerable ones after the instance's own keys (a key that is
// already own is listed once, where it is own; a non-enumerable one never), `in`
// sees them, and `Object.keys` does not.
class ExtPoint {
  constructor(x, y) {
    this.x = x
    this.y = y
  }
}
const names = ['flag', 'shade']
for (const name of names) ExtPoint.prototype[name] = name.length
const hidden = {}
for (const name of ['hidden']) hidden[name] = { get: () => 1 }
Object.defineProperties(ExtPoint.prototype, hidden)
const point = new ExtPoint(1, 2)
const listed = []
for (const key in point) listed.push(key)
console.log('for-in', listed.join(','))
const shadow = new ExtPoint(3, 4)
shadow.flag = 0
const shadowed = []
for (const key in shadow) shadowed.push(key)
console.log('shadowed', shadowed.join(','))
console.log('in', 'flag' in point, 'hidden' in point, 'missing' in point, 'x' in point)
console.log('own', Object.keys(point).join(','), '|', Object.getOwnPropertyNames(point).join(','))
