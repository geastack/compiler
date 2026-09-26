// @ts-nocheck
//! expect: float16 1 true | 1 a2 | 0 false
//! emitted-has: gea::mapFromPairArray
// A Map keyed by class objects compares the classes themselves: three looks
// its vertex format up by an attribute's class
// (WebGPUAttributeUtils's typedAttributeToVertexFormatPrefix).
class Float16Attribute {}
const byClass = new Map( [
	[ Float16Attribute, [ 'float16', ]],
] );
class Attribute {}
const named = new Map();
named.set( Attribute, 'a' );
named.set( Attribute, 'a2' );
const before = named.size + ' ' + named.get( Attribute );
named.delete( Attribute );
console.log( byClass.get( Float16Attribute )[ 0 ], byClass.size, byClass.has( Float16Attribute ), '|', before, '|', named.size, named.has( Attribute ) );
