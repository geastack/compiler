class EventDispatcher {

	/**
	 * @param {string} type
	 * @param {Function} listener
	 */
	addEventListener( type, listener ) {

		if ( this._listeners === undefined ) this._listeners = {};
		const listeners = this._listeners;
		if ( listeners[ type ] === undefined ) listeners[ type ] = [];
		listeners[ type ].push( listener );

	}

}

export { EventDispatcher };
