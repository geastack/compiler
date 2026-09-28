import { EventDispatcher } from './EventDispatcher.js';
import { Vector2 } from './Vector2.js';

class Texture extends EventDispatcher {

	constructor() {

		super();

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isTexture = true;

		/**
		 * @type {Vector2}
		 */
		this.offset = new Vector2( 0, 0 );

	}

}

export { Texture };
