// @ts-nocheck
// three's TSL `nodeProxy( ... ).setParameterLength( 2 )`: a function property
// set on a rest-taking callable returns that callable, and the call result is
// boxed where no ABI is in view (`DynamicCarrier::out`). `(...xs)` and `(xs)`
// are one physical signature, so the box reads the rest position the function
// object stated where it was created; positional reading handed `1` to the
// packed-array slot.
const make = ( scope = null ) => {
	let fn, limit;
	if ( scope === null ) fn = ( ...params ) => params.length + ( limit ?? 0 );
	else fn = ( ...params ) => params.length * 10;
	fn.setLimit = ( ...params ) => {
		limit = params[ 0 ];
		return fn;
	};
	return fn;
};
const direct = make();
console.log( direct( 1, 2, 3 ) );
const chained = make().setLimit( 2 );
console.log( chained( 1, 2, 3 ) );
export {};

//! expect: 3
//! expect: 5
