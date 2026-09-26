// @ts-nocheck
// A JavaScript class declares a field by assigning it an empty array, and
// fills it elsewhere. The field's storage is named at the assignment's left
// side, where the checker answers the write's `any` rather than the member's
// `any[]`, so the class layout kept the checker's `any[]` while the array
// census typed every read from the pushes -- one storage, two carriers.
class Mesh {
	constructor( n ) { this.n = n; }
}
function make( n ) {
	const xs = [];
	for ( let i = 0; i < n; i ++ ) xs.push( i * 2 );
	return { xs };
}
class Bag {
	constructor() {
		this.values = [];
		this.meshes = [];
		this.xs = [];
	}
	add( v ) {
		this.values.push( v * 2 );
		this.meshes.push( new Mesh( v ) );
	}
	refill( n ) {
		this.xs = make( n ).xs;
	}
}
const bag = new Bag();
bag.add( 3 );
bag.add( 4 );
bag.refill( 3 );
console.log( bag.values.length, bag.values[ 1 ], bag.meshes[ 0 ].n, bag.xs.length, bag.xs[ 2 ] );
//! expect: 2 8 3 3 4
