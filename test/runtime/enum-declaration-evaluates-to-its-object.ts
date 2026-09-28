//! expect: num other other
//! expect: 0 Str 5 b 6 Num
// An enum is one object bound where it is declared: each member's constant
// under its name, and a numeric member's name under its value.
enum Type {
  Num,
  Str,
}

enum Mixed {
  A = 5,
  B = 'b',
  C = A + 1,
}

function describe(t?: Type): string {
  return t === Type.Num ? 'num' : 'other'
}

console.log(describe(Type.Num), describe(Type.Str), describe())
const zero: number = JSON.parse('0')
console.log(Type.Num, Type[Type.Str], Mixed.A, Mixed.B, Mixed.C, Type[zero])
