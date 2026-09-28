class RenderObject {

	/**
	 * @param {Object3D} object
	 * @param {Array<string>} names
	 */
	constructor( object, names ) {

		/**
		 * @type {Object3D}
		 */
		this.object = object;

		/**
		 * @type {BufferGeometry}
		 */
		this.geometry = object.geometry;

		/**
		 * @type {?Array<BufferAttribute>}
		 */
		this.attributes = null;

		/**
		 * @type {?Array<BufferAttribute|InterleavedBuffer>}
		 */
		this.vertexBuffers = null;

		/**
		 * @type {?Object<string, number|string>}
		 */
		this.attributesId = null;

		/** @type {Array<string>} */
		this.names = names;

	}

	/**
	 * @return {Array<BufferAttribute>}
	 */
	getAttributes() {

		if ( this.attributes !== null ) return this.attributes;

		const geometry = this.geometry;

		const attributes = [];
		const vertexBuffers = new Set();

		const attributesId = {};

		for ( const name of this.names ) {

			let attribute;

			attribute = geometry.getAttribute( name );

			if ( attribute !== undefined ) {

				if ( attribute.isInterleavedBufferAttribute ) {

					attributesId[ name ] = attribute.data.uuid;

				} else {

					attributesId[ name ] = attribute.id;

				}

			}

			if ( attribute === undefined ) continue;

			attributes.push( attribute );

			const bufferAttribute = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
			vertexBuffers.add( bufferAttribute );

		}

		this.attributes = attributes;
		this.attributesId = attributesId;
		this.vertexBuffers = Array.from( vertexBuffers.values() );

		return attributes;

	}

	/**
	 * @return {Array<BufferAttribute|InterleavedBuffer>}
	 */
	getVertexBuffers() {

		if ( this.vertexBuffers === null ) this.getAttributes();

		return this.vertexBuffers;

	}

}

export default RenderObject;
