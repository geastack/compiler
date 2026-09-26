// @ts-nocheck
//! expect: true false true false true
// three's `DataMap.get` (`renderers/common/DataMap.js`) keys a WeakMap by an
// `{Object}` parameter. Every call site boxes the same record again, and a
// weak key compares on the object, not on the box that carries it.
class Manager {
	constructor() { this.data = new WeakMap(); }
	/**
	 * @param {Object} o
	 * @return {Object}
	 */
	get( o ) {
		let d = this.data.get( o );
		if ( d === undefined ) {
			d = {};
			this.data.set( o, d );
		}
		return d;
	}
	/**
	 * @param {Object} ro
	 * @return {boolean}
	 */
	touch( ro ) {
		const data = this.get( ro );
		const fresh = data.state === undefined;
		if ( fresh ) data.state = 1;
		return fresh;
	}
}
const m = new Manager();
const k = {};
const out = [];
out.push( m.touch( k ) );
out.push( m.touch( k ) );
out.push( m.touch( {} ) );
out.push( m.touch( k ) );
out.push( m.data.has( k ) );
console.log( out.join( ' ' ) );
