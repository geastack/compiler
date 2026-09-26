// @ts-nocheck
//! expect: 0 1 2
// three's `NodeManager.getForRender` (`renderers/common/nodes/NodeManager.js`):
// `@return {NodeBuilderState|Promise<NodeBuilderState>}`, and the async path
// returns a `.then(...)` whose handler answers an untyped data-map read, so a
// `Promise<any>` lands in the union's one promise arm.
class State {
	constructor( usedTimes ) { this.usedTimes = usedTimes; }
}
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
	 * @param {boolean} [useAsync=false]
	 * @return {State|Promise<State>}
	 */
	getForRender( ro, useAsync = false ) {
		const data = this.get( ro );
		let state = data.state;
		if ( state === undefined ) {
			if ( useAsync ) {
				return Promise.resolve( 1 ).then( ( times ) => {
					data.state = new State( times );
					return data.state;
				} );
			}
			state = new State( 0 );
			data.state = state;
		}
		return state;
	}
	/**
	 * @param {Object} ro
	 * @return {Promise<State>}
	 */
	getForRenderAsync( ro ) {
		const result = this.getForRender( ro, true );
		if ( result instanceof Promise ) {
			return result;
		}
		return Promise.resolve( result );
	}
}
const m = new Manager();
const k = {};
const out = [];
out.push( m.getForRender( k ).usedTimes );
m.getForRenderAsync( {} ).then( ( s ) => {
	out.push( s.usedTimes );
	return m.getForRenderAsync( k );
} ).then( ( s ) => {
	out.push( s.usedTimes + 2 );
	console.log( out.join( ' ' ) );
} );
