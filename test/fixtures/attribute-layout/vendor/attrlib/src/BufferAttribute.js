import { EventDispatcher } from './EventDispatcher.js';

let _id = 0;

class BufferAttribute extends EventDispatcher {

	/**
	 * @param {Float32Array} array
	 * @param {number} itemSize
	 */
	constructor( array, itemSize ) {

		super();

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isBufferAttribute = true;

		/** @type {Float32Array} */
		this.array = array;

		/** @type {number} */
		this.itemSize = itemSize;

		/** @type {number} */
		this.id = _id ++;

	}

}

export { BufferAttribute };
