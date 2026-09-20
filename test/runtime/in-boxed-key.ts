// `k in o` where the KEY is a value the program never typed. ToPropertyKey
// (ECMA-262 7.1.19) starts with ToPrimitive, and ToPrimitive over an ordinary
// object calls user code -- so the emitter refused every boxed key outright,
// and with it the whole operator. But the box's TAG says what it holds, and
// ToPrimitive is the identity for every primitive: only an Object or Function
// payload needs the dispatch that does not exist, and that one aborts by name
// rather than fabricating a key. three's `uuid in _materialCache` and
// `u.id in values` are both a string or a number key through an untyped cell.
const table: any = { alpha: 1, seven: 7 }

const probe = (key: any): string => String(key in table)

console.log(`text=${probe('alpha')}`)
console.log(`absent=${probe('beta')}`)
console.log(`number=${probe(7)}`)

const hasAlpha = (value: unknown): boolean => value != null && typeof value === 'object' && 'alpha' in value

console.log(`unknown-object-present=${hasAlpha({ alpha: 1 })}`)
console.log(`unknown-object-absent=${hasAlpha({ beta: 2 })}`)

//! emitted-has: toPropertyKey
//! expect: text=true
//! expect: absent=false
//! expect: number=false
//! expect: unknown-object-present=true
//! expect: unknown-object-absent=false
