import { EventDispatcher } from './EventDispatcher.js';

class BufferGeometry extends EventDispatcher {

	constructor() {

		super();

		/** @type {Object<string,(BufferAttribute|InterleavedBufferAttribute)>} */
		this.attributes = {};

	}

	/**
	 * @param {string} name
	 * @return {BufferAttribute|InterleavedBufferAttribute|undefined}
	 */
	getAttribute( name ) {

		return this.attributes[ name ];

	}

	/**
	 * @param {string} name
	 * @param {BufferAttribute|InterleavedBufferAttribute} attribute
	 * @return {BufferGeometry}
	 */
	setAttribute( name, attribute ) {

		this.attributes[ name ] = attribute;
		return this;

	}

}

export { BufferGeometry };
