// @ts-nocheck
//! expect: 2 1 0 x,3
//! expect: 1 true

// three's NodeBuilder fills per-stage lists with empty literals inside an
// object literal (`this.structs = { vertex: [], fragment: [], compute: [],
// index: 0 }`) and pushes into them through a field it types `{Object}`, so
// the array census sees no writes and boxes each `[]`. The object literal's
// own field was still the checker's `never[]` (`array-object(undefined)`),
// and storing the boxed literal into it was a conversion between two array
// carriers of one array that nothing performs.
class Builder {
	constructor() {
		/**
		 * @type {Object}
		 */
		this.structs = { vertex: [], fragment: [], compute: [], index: 0 };
		this.cached = { renderId: - 1, lightsData: [] };
	}
	add( stage, value ) {
		this.structs[ stage ].push( value );
		return this.structs[ stage ].length;
	}
}
const builder = new Builder();
builder.add( 'vertex', 'x' );
builder.add( 'vertex', 3 );
builder.add( 'fragment', true );
console.log( builder.structs.vertex.length, builder.structs.fragment.length, builder.structs.compute.length, builder.structs.vertex.join( ',' ) );
builder.cached.lightsData.push( { id: 1 } );
console.log( builder.cached.lightsData.length, builder.cached.renderId < 0 );
