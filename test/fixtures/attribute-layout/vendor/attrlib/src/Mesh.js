import { Object3D } from './Object3D.js';
import { BufferGeometry } from './BufferGeometry.js';

class Mesh extends Object3D {

	/**
	 * @param {BufferGeometry} [geometry]
	 */
	constructor( geometry = new BufferGeometry() ) {

		super();

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isMesh = true;

		/**
		 * @type {BufferGeometry}
		 */
		this.geometry = geometry;

	}

}

export { Mesh };
