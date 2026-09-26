// @ts-nocheck
//! expect: material,a|a
// three's `NodeBuilder.addContext` / `getSharedContext` (`nodes/core/NodeBuilder.js`):
// `this.context` is `@type {Object}`, and `{ ...this.context }` copies
// whatever that object holds. The checker gives the literal the `Object`
// interface's own members, which are not its keys.
class Builder {
	constructor() {
		/** @type {Object} */
		this.context = { material: null };
	}
	/** @return {Object} */
	getContext() { return this.context; }
	/** @param {Object} context */
	setContext( context ) { this.context = context; }
	/**
	 * @param {Object} context
	 * @return {Object}
	 */
	addContext( context ) {
		const previousContext = this.getContext();
		this.setContext( { ...this.context, ...context } );
		return previousContext;
	}
	/** @return {Object} */
	getSharedContext() {
		const context = { ...this.context };
		delete context.material;
		return context;
	}
}
const b = new Builder();
b.addContext( { a: 1 } );
console.log( Object.keys( b.getContext() ).join( ',' ) + '|' + Object.keys( b.getSharedContext() ).join( ',' ) );
