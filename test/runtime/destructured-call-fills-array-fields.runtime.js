// @ts-nocheck
// three's PMREMGenerator fills three array fields from one call:
// `({ lodMeshes: this._lodMeshes, ... } = _createPlanes( _lodMax ))`. The
// flow index records that pattern write with no value, so the array census
// saw no write reaching the fields' `[]` and left them boxed, while the
// arrays `_createPlanes` returns were typed from their pushes. The fields
// hold those very arrays, so they share their element carrier.
class Mesh { constructor( geometry ) { this.geometry = geometry } }
class Geometry { constructor( n ) { this.n = n } dispose() { console.log( 'dispose', this.n ) } }
function _createPlanes( lodMax ) {
	const sizeLods = [];
	const sigmas = [];
	const lodMeshes = [];
	let lod = lodMax;
	for ( let i = 0; i < 3; i ++ ) {
		const sizeLod = Math.pow( 2, lod );
		sizeLods.push( sizeLod );
		sigmas.push( i * 0.5 );
		lodMeshes.push( new Mesh( new Geometry( i ) ) );
		lod --;
	}
	return { lodMeshes, sizeLods, sigmas };
}
class PMREMGenerator {
	constructor() {
		this._lodMax = 0;
		this._sizeLods = [];
		this._sigmas = [];
		this._lodMeshes = [];
	}
	_setSize( cubeSize ) {
		this._lodMax = Math.floor( Math.log2( cubeSize ) );
		const { _lodMax } = this;
		( { lodMeshes: this._lodMeshes, sizeLods: this._sizeLods, sigmas: this._sigmas } = _createPlanes( _lodMax ) );
	}
	dispose() {
		for ( let i = 0; i < this._lodMeshes.length; i ++ ) this._lodMeshes[ i ].geometry.dispose();
	}
	size( lodOut ) { return this._sizeLods[ lodOut ] - 1 + this._sigmas[ lodOut ] }
}
const g = new PMREMGenerator();
g._setSize( 256 );
console.log( g.size( 1 ), g._lodMeshes.length, g._sizeLods[ 0 ] );
g.dispose();
//! expect: 127.5 3 256
//! expect: dispose 0
//! expect: dispose 1
//! expect: dispose 2
