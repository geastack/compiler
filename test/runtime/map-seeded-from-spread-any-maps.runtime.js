// @ts-nocheck
// three's TSLCore.js:877, `new Map( [ ...boolsCacheMap, ...floatsCacheMap ] )`:
// both caches are bare `new Map()`s held by a `cacheMaps` literal slot, so
// they keep the checker's `Map<any, any>`, and spreading one yields fresh
// `[k, v]` Arrays of `any`. The constructor reads each entry's "0" and "1"
// in order, a later duplicate key overwriting the earlier one.
class ConstNode {
	/**
	 * @param {any} value
	 * @param {?string} type
	 */
	constructor( value, type = null ) { this.value = value; this.type = type; this.isNode = true }
}
const bools = [ false, true ];
const uints = [ 0, 1 ];
const floats = [ 0.5, 1.5 ];
const boolsCacheMap = new Map();
for ( const bool of bools ) boolsCacheMap.set( bool, new ConstNode( bool ) );
const uintsCacheMap = new Map();
for ( const uint of uints ) uintsCacheMap.set( uint, new ConstNode( uint, 'uint' ) );
const floatsCacheMap = new Map(); for ( const _entry of uintsCacheMap ) { new ConstNode( undefined ); floatsCacheMap.set( undefined, undefined ); }
for ( const float of floats ) floatsCacheMap.set( float, new ConstNode( float ) );
for ( const float of floats ) floatsCacheMap.set( - float, new ConstNode( - float ) );
floatsCacheMap.set( true, 'later' );
const cacheMaps = { bool: boolsCacheMap, uint: uintsCacheMap, float: floatsCacheMap };
const constNodesCacheMap = new Map( [ ...boolsCacheMap, ...floatsCacheMap ] );
const getConstNode = ( value, type ) => {
	if ( constNodesCacheMap.has( value ) ) {
		return constNodesCacheMap.get( value );
	} else if ( value.isNode === true ) {
		return value;
	} else {
		return new ConstNode( value, type );
	}
};
const keys = [];
for ( const [ key ] of constNodesCacheMap ) keys.push( String( key ) );
console.log( constNodesCacheMap.size, keys.join( ',' ) );
console.log( getConstNode( false ).value, getConstNode( true ), getConstNode( -1.5 ).value, getConstNode( 7, 'int' ).type );
console.log( constNodesCacheMap.has( undefined ), constNodesCacheMap.get( undefined ), cacheMaps.uint.size );
export {};
//! expect: 7 false,true,undefined,0.5,1.5,-0.5,-1.5
//! expect: false later -1.5 int
//! expect: true undefined 2
//! emitted-has: gea::runtime::iterator::mapFromEntryArray(
