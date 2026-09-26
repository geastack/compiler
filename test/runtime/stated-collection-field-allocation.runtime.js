// @ts-nocheck
//! expect: 2 b
//! expect: 0 true 0
//! expect: 0

// three's renderer components fill a JSDoc-typed field with a bare
// collection (`/** @type {Map<string,Pipeline>} */ this.caches = new Map()`,
// `Pipelines.js`). In JavaScript the checker types the `new Map()` itself
// `Map<any, any>` -- uninferred type arguments default to `any` there -- while
// the field it fills is `Map<string, Pipeline>`. The collection census then
// inferred the allocation from its writes (the key an untyped parameter, so
// `Map<any, Pipeline>`), and the store into the field was a conversion
// between two Map carriers nothing can perform without copying the map. The
// field's own statement is the answer for the allocation, as a TypeScript
// file's contextual inference would give.
class Pipeline {
	constructor( cacheKey ) {
		this.cacheKey = cacheKey;
	}
}
class Pipelines {
	constructor() {
		/**
		 * @type {Map<string,Pipeline>}
		 */
		this.caches = new Map();
		/**
		 * @type {Map<string, Object>}
		 */
		this.samplers = new Map();
		/**
		 * @type {Set<Pipeline>}
		 */
		this.pending = new Set();
	}
	get( cacheKey ) {
		let pipeline = this.caches.get( cacheKey );
		if ( pipeline === undefined ) {
			pipeline = new Pipeline( cacheKey );
			this.caches.set( cacheKey, pipeline );
			this.pending.add( pipeline );
		}
		return pipeline;
	}
	sampler( key ) {
		let sampler = this.samplers.get( key );
		if ( sampler === undefined ) {
			sampler = { key, uses: 0 };
			this.samplers.set( key, sampler );
		}
		return sampler;
	}
	dispose() {
		this.caches = new Map();
	}
}
const pipelines = new Pipelines();
pipelines.get( 'a' );
pipelines.get( 'b' );
pipelines.get( 'a' );
console.log( pipelines.caches.size, pipelines.get( 'b' ).cacheKey );
console.log( pipelines.samplers.size + ( pipelines.sampler( 'linear' ) === pipelines.sampler( 'linear' ) ? 0 : 5 ), pipelines.pending.has( pipelines.get( 'a' ) ), pipelines.sampler( 'linear' ).uses );
pipelines.dispose();
console.log( pipelines.caches.size );
