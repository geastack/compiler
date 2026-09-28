import { BufferAttribute } from './BufferAttribute.js';

class AttributeUtils {

	/**
	 * @param {RenderObject} renderObject
	 * @return {number}
	 */
	vertexLayout( renderObject ) {

		const attributes = renderObject.getAttributes();
		let total = 0;

		for ( let slot = 0; slot < attributes.length; slot ++ ) {

			const geometryAttribute = attributes[ slot ];
			const bytesPerElement = geometryAttribute.array.BYTES_PER_ELEMENT;

			const offset = ( geometryAttribute.isInterleavedBufferAttribute === true ) ? geometryAttribute.offset * bytesPerElement : 0;

			total += offset + geometryAttribute.itemSize;

		}

		return total;

	}

	/**
	 * @param {BufferAttribute} attribute
	 * @return {boolean}
	 */
	isPlain( attribute ) {

		return attribute instanceof BufferAttribute;

	}

}

export default AttributeUtils;
