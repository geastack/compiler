class InterleavedBuffer {

	/**
	 * @param {Float32Array} array
	 * @param {number} stride
	 */
	constructor( array, stride ) {

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isInterleavedBuffer = true;

		/** @type {Float32Array} */
		this.array = array;

		/** @type {number} */
		this.stride = stride;

		/** @type {string} */
		this.uuid = 'ib' + stride;

	}

}

export { InterleavedBuffer };
