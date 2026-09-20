// @ts-nocheck
// ECMA-262 10.1.11.1 OrdinaryOwnPropertyKeys: string keys come back in
// property-creation order, which for an object literal is declaration order.
var o = { b: 1, a: 2, c: 3 }
console.log(Object.keys(o).join(','), Object.getOwnPropertyNames(o).join(','), JSON.stringify(o))
//! expect: b,a,c b,a,c {"b":1,"a":2,"c":3}
var d = Object.getOwnPropertyDescriptor(o, 'a')
console.log(Object.getOwnPropertyNames(d).join(','))
// The descriptor minted for this call carries its fields in ECMA-262
// 6.2.6.4 FromPropertyDescriptor's creation order even though the binding
// `d` is declared with the AMBIENT `PropertyDescriptor` interface, whose
// record lists its members in lib.d.ts declaration order (configurable,
// enumerable, value, writable, get, set). The own-key walk used to read the
// ambient layout and print that order.
//! expect: value,writable,enumerable,configurable
