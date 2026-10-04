// @ts-nocheck
// A one-formal arrow stored in a slot typed like an array-method callback,
// `(value, index, all: number[])`, is adapted by dropping the trailing formals
// it never reads. The slot ends in an array, so a dynamic call must know whether
// `all` collects a rest list. The adapter cannot say, but it never reads that
// formal, so its fact is "unread from 1". Returned through a function property,
// the callable is boxed where no ABI is in view (`DynamicCarrier::out`), and the
// dynamic call binds `value` and leaves the unread formals at their default.
const make = () => {
	let fn;
	fn = ( n ) => n;
	/** @type {(value: number, index: number, all: number[]) => number} */
	const wide = ( x ) => x * 2;
	fn.slot = () => wide;
	return fn;
};
const got = make().slot();
console.log( got( 21 ) );
console.log( got( 4, 1, [ 1, 2 ] ) );
console.log( got( 5, 'not an index', 'not an array' ) );
export {};

//! expect: 42
//! expect: 8
//! expect: 10
