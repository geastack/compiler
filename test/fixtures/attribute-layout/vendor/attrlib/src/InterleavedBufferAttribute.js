class InterleavedBufferAttribute {

	/**
	 * @param {InterleavedBuffer} interleavedBuffer
	 * @param {number} itemSize
	 * @param {number} offset
	 */
	constructor( interleavedBuffer, itemSize, offset ) {

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isInterleavedBufferAttribute = true;

		/** @type {InterleavedBuffer} */
		this.data = interleavedBuffer;

		/** @type {number} */
		this.itemSize = itemSize;

		/** @type {number} */
		this.offset = offset;

	}

	/** @type {Float32Array} */
	get array() {

		return this.data.array;

	}

}

export { InterleavedBufferAttribute };
