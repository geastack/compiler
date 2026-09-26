// @ts-nocheck
//! expect: true null false frame
// three's `Node.onUpdate` (`nodes/core/Node.js`): a `{Function}` callback,
// bound to the node, replaces a method declared `@return {?boolean}`. The
// bound value is dynamic, so the method slot reads it through a checked
// adapter whose result's absence is `null`, not `undefined`.
class Updatable {
	constructor() { this.updateType = 'none'; this.level = 0; }
	/**
	 * @param {number} frame
	 * @return {?boolean}
	 */
	update( frame ) { return frame > 0 ? true : null; }
	/**
	 * @param {Function} callback
	 * @param {string} updateType
	 * @return {Updatable}
	 */
	onUpdate( callback, updateType ) {
		this.updateType = updateType;
		this.update = callback.bind( this );
		return this;
	}
}
const plain = new Updatable();
/**
 * @param {number} frame
 * @return {?boolean}
 */
function onFrame( frame ) { return frame > 2 ? null : false; }
const node = new Updatable().onUpdate( onFrame, 'frame' );
console.log( plain.update( 1 ), node.update( 5 ), node.update( 1 ), node.updateType );
