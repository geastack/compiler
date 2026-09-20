//! expect: direct true false false true
//! expect: optional-union true false true false
//! expect: reversed true false false true
//! expect: overlap true true false false
//! expect: overlap-pair true true false true
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class Base {
  value = 1
}
class Derived extends Base {
  detail = 2
}

function same(base: Base, derived: Derived): boolean {
  return base === derived
}
function different(derived: Derived, base: Base): boolean {
  return derived !== base
}
function optional(base: Base | undefined, derived: Derived): boolean {
  return base === derived
}
function union(base: Base | string, derived: Derived): boolean {
  return base === derived
}
function reverseUnion(derived: Derived, base: Base | string): boolean {
  return derived !== base
}

const first = new Derived()
const second = new Derived()
console.log('direct', same(first, first), same(first, second), different(first, first), different(first, second))
console.log('optional-union', optional(first, first), optional(undefined, first), union(first, first), union('absent', first))
console.log('reversed', reverseUnion(first, second), reverseUnion(first, first), union(second, first), reverseUnion(first, 'absent'))

function overlap(value: Base | Derived | string, other: Base): boolean {
  return value === other
}
function overlapPair(left: Base | Derived | string, right: Base | Derived | string): boolean {
  return left === right
}
function asBase(value: Base): Base {
  return value
}
const plain = new Base()
console.log('overlap', overlap(first, first), overlap(plain, plain), overlap(first, plain), overlap('absent', plain))
console.log(
  'overlap-pair',
  overlapPair(first, asBase(first)),
  overlapPair(asBase(first), first),
  overlapPair(first, second),
  overlapPair('tag', 'tag')
)
