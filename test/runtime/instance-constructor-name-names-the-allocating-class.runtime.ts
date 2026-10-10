// `x.constructor.name` answers the class that allocated `x`, whatever class
// the receiver is typed as (a database client's test helper `errorStrictEqual` compares
// `lhs.constructor.name !== rhs.constructor.name`).
class Base {}
class Derived extends Base {}
class Leaf extends Derived {}
const items: Base[] = [new Base(), new Derived(), new Leaf()]
console.log(items.map((item) => item.constructor.name).join(' '))
const sameClass = (left: Base, right: Base): boolean => left.constructor.name === right.constructor.name
console.log(sameClass(items[1]!, new Derived()), sameClass(items[0]!, items[2]!))
//! expect: Base Derived Leaf
//! expect: true false
export {}
