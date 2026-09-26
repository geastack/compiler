// @ts-nocheck
//! expect: function object function null
// three's `overrideNode` (`nodes/core/OverrideContextNode.js`): a parameter
// declared `{Function|Node|null}` is reassigned an arrow when it held a
// node, so a callable with a static ABI lands in the broad `Function` arm.
class Box {
	constructor( v ) { this.isNode = true; this.v = v; }
}
class Holder {
	/** @param {Function|Box|null} callback */
	constructor( callback ) { this.callback = callback; }
	/** @return {?string} */
	kind() {
		const callback = this.callback;
		if ( callback === null ) return null;
		return typeof callback;
	}
}
/**
 * @param {Function|Box|null} [callback=null]
 * @return {Holder}
 */
function override( callback = null ) {
	if ( callback && callback.isNode ) {
		const node = callback;
		callback = () => node;
	}
	return new Holder( callback );
}
const n = new Box( 7 );
console.log( override( n ).kind(), new Holder( n ).kind(), override( () => new Box( 8 ) ).kind(), override().kind() );
