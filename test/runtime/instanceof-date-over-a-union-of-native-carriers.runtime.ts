// A binary-document serializer's `isDate(value)` asks `value instanceof Date` of whatever carrier its
// caller holds. Over a union the discriminant answers every arm that is a
// settled physical allocation -- a string, a Map, a dictionary are never a
// Date -- and only the Date arm itself reads true. The Date composite was the
// one native protocol with no renderer for a `tagged-union` left operand, so
// the whole program was refused at certify.
type Doc = { [key: string]: number }

function isDate(value: Doc | Map<string, number> | Date): number {
  return value instanceof Date ? 1 : 0
}

function isDateOrText(value: string | Date | Map<string, number>): number {
  return value instanceof Date ? 1 : 0
}

console.log(isDate({ a: 1 }), isDate(new Map<string, number>()), isDate(new Date(5)))
console.log(isDateOrText('x'), isDateOrText(new Date(7)), isDateOrText(new Map<string, number>()))
//! expect: 0 0 1
//! expect: 0 1 0
