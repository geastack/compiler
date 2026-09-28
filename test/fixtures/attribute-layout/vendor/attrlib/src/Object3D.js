import { EventDispatcher } from './EventDispatcher.js';

class Object3D extends EventDispatcher {

	constructor() {

		super();

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isObject3D = true;

	}

}

export { Object3D };
