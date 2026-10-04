// @ts-nocheck
// three's TSLCore verifyParamsLimit: `params.slice( 0, maxParams )` over an
// untyped rest list, with `maxParams` itself `any`. ECMA-262 23.1.3.28 reads
// the receiver's length BEFORE it coerces `start` and then `end`, and ToNumber
// of an object runs its valueOf -- here ones that log, grow the very list being
// sliced, or empty it. An index the list no longer holds is a hole.
/**
 * @param {any[]} list
 * @param {any} start
 * @param {any} end
 */
const cut = ( list, start, end ) => list.slice( start, end );
/**
 * @param {any[]} list
 * @param {any} end
 */
const head = ( list, end ) => list.slice( 0, end );
/**
 * @param {any[]} list
 * @param {any} start
 */
const from = ( list, start ) => list.slice( start );
/**
 * @param {any[]} list
 * @param {any} start
 */
const two = ( list, start ) => list.slice( start, 2 );

const log = [];
/** @type {any[]} */
const growing = [ 'a', 'b', 'c' ];
const starts = { valueOf() { log.push( 'start' ); return 1; } };
const grows = { valueOf() { log.push( 'end' ); growing.push( 'late' ); return 10; } };
console.log( cut( growing, starts, grows ).join( ',' ), growing.length, log.join( ',' ) );

/** @type {any[]} */
const shrinking = [ 'a', 'b', 'c', 'd' ];
const empties = { valueOf() { shrinking.splice( 1 ); return 3; } };
const cutShort = head( shrinking, empties );
console.log( cutShort.length, cutShort.join( '|' ), shrinking.length );

/** @type {any[]} */
const letters = [ 'x', 'y', 'z' ];
console.log( head( letters, undefined ).length, from( letters, '-2' ).join( ',' ), cut( letters, null, NaN ).length, two( letters, true ).join( ',' ) );
console.log( head( letters, 2 ).join( ',' ), from( letters, undefined ).join( ',' ), cut( letters, -1, undefined ).join( ',' ) );

export {};

//! expect: b,c 4 start,end
//! expect: 3 a|| 1
//! expect: 3 y,z 0 y
//! expect: x,y x,y,z z
