// @ts-nocheck
//! expect: layer quad 2 space
//! known-wrong: select index -1 -- the inputSource stored into the Array<?Object> is a boxed COPY of its owned record, so neither this lookup nor onSessionEvent's finds it; node prints `select index 0` and `event select 0 space`
//! expect: loop 16 7
//! expect: planes 7
//! expect: frame true
//! expect: sources 1 connected 1
//! expect: ended false 1
//! expect: keys 1
//! emitted-has: gea::bindCallable<void(gea::Value, gea::Value), 0>
// three's XRManager (renderers/common/XRManager.js) binds five module
// functions in its constructor, each stored in a `@type {Function}` field.
// `onAnimationFrame( time, frame )` writes `this._xrFrame`, so the checker
// infers it as a constructor whose `this` is its own layout; `@this` names
// the XRManager the bind sites pass, and lib's OmitThisParameter result
// carries the remaining `( time, frame )` frame.
class EventDispatcher {
	addEventListener( type, listener ) {
		if ( this._listeners === undefined ) this._listeners = {};
		const listeners = this._listeners;
		if ( listeners[ type ] === undefined ) listeners[ type ] = [];
		if ( listeners[ type ].indexOf( listener ) === - 1 ) listeners[ type ].push( listener );
	}
	removeEventListener( type, listener ) {
		if ( this._listeners === undefined ) return;
		const listenerArray = this._listeners[ type ];
		if ( listenerArray !== undefined ) {
			const index = listenerArray.indexOf( listener );
			if ( index !== - 1 ) listenerArray.splice( index, 1 );
		}
	}
	dispatchEvent( event ) {
		if ( this._listeners === undefined ) return;
		const listenerArray = this._listeners[ event.type ];
		if ( listenerArray !== undefined ) {
			event.target = this;
			const array = listenerArray.slice( 0 );
			for ( let i = 0, l = array.length; i < l; i ++ ) array[ i ].call( this, event );
			event.target = null;
		}
	}
}
class Animation {
	constructor() {
		this._animationLoop = null;
	}
	setAnimationLoop( callback ) {
		this._animationLoop = callback;
	}
	tick( time, frame ) {
		if ( this._animationLoop !== null ) this._animationLoop( time, frame );
	}
}
class Controller {
	constructor() {
		this.connected = 0;
	}
	connect( inputSource ) {
		this.connected ++;
	}
	disconnect( inputSource ) {
		this.connected --;
	}
	update( inputSource, frame, referenceSpace ) {}
}
class XRManager extends EventDispatcher {
	constructor( renderer ) {
		super();
		/**
		 * @private
		 * @type {Renderer}
		 */
		this._renderer = renderer;
		/**
		 * @private
		 * @type {Array<Controller>}
		 */
		this._controllers = [ new Controller() ];
		/**
		 * @private
		 * @type {Array<?Object>}
		 */
		this._controllerInputSources = [];
		/**
		 * @private
		 * @type {?Function}
		 * @default null
		 */
		this._currentAnimationLoop = null;
		/**
		 * @private
		 * @type {?Object}
		 * @default null
		 */
		this._xrFrame = null;
		/**
		 * @private
		 * @type {?Object}
		 * @default null
		 */
		this._session = null;
		/**
		 * Helper function to create native WebXR Layer.
		 *
		 * @private
		 * @type {Function}
		 */
		this._createXRLayer = createXRLayer.bind( this );
		/**
		 * @private
		 * @type {Function}
		 */
		this._onSessionEvent = onSessionEvent.bind( this );
		/**
		 * @private
		 * @type {Function}
		 */
		this._onSessionEnd = onSessionEnd.bind( this );
		/**
		 * @private
		 * @type {Function}
		 */
		this._onInputSourcesChange = onInputSourcesChange.bind( this );
		/**
		 * @private
		 * @type {Function}
		 */
		this._onAnimationFrame = onAnimationFrame.bind( this );
	}
	getReferenceSpace() {
		return 'space';
	}
	setAnimationLoop( callback ) {
		this._currentAnimationLoop = callback;
	}
	createLayer( layer ) {
		layer.xrlayer = this._createXRLayer( layer );
		return layer.xrlayer;
	}
	setSession( session ) {
		this._session = session;
		session.addEventListener( 'select', this._onSessionEvent );
		session.addEventListener( 'end', this._onSessionEnd );
		session.addEventListener( 'inputsourceschange', this._onInputSourcesChange );
		this._renderer._animation.setAnimationLoop( this._onAnimationFrame );
	}
}
class Renderer {
	constructor() {
		this._animation = new Animation();
	}
}
function onSessionEvent( event ) {
	const controllerIndex = this._controllerInputSources.indexOf( event.inputSource );
	if ( controllerIndex === - 1 ) {
		return;
	}
	const controller = this._controllers[ controllerIndex ];
	if ( controller !== undefined ) {
		const referenceSpace = this.getReferenceSpace();
		controller.update( event.inputSource, event.frame, referenceSpace );
		console.log( 'event', event.type, controllerIndex, referenceSpace );
	}
}
function onSessionEnd() {
	const session = this._session;
	session.removeEventListener( 'select', this._onSessionEvent );
	session.removeEventListener( 'end', this._onSessionEnd );
	session.removeEventListener( 'inputsourceschange', this._onInputSourcesChange );
	this._session = null;
}
function onInputSourcesChange( event ) {
	const controllers = this._controllers;
	const controllerInputSources = this._controllerInputSources;
	for ( let i = 0; i < event.added.length; i ++ ) {
		const inputSource = event.added[ i ];
		let controllerIndex = controllerInputSources.indexOf( inputSource );
		if ( controllerIndex === - 1 ) {
			for ( let i = 0; i < controllers.length; i ++ ) {
				if ( i >= controllerInputSources.length ) {
					controllerInputSources.push( inputSource );
					controllerIndex = i;
					break;
				}
			}
			if ( controllerIndex === - 1 ) break;
		}
		const controller = controllers[ controllerIndex ];
		if ( controller ) {
			controller.connect( inputSource );
		}
	}
}
function createXRLayer( layer ) {
	if ( layer.type === 'quad' ) {
		return layer.type + ' ' + ( layer.width / 2 ) + ' ' + this.getReferenceSpace();
	} else {
		return 'cylinder';
	}
}
function onAnimationFrame( time, frame ) {
	if ( frame === undefined ) return;
	const referenceSpace = this.getReferenceSpace();
	this._xrFrame = frame;
	if ( this._currentAnimationLoop ) this._currentAnimationLoop( time, frame );
	if ( frame.detectedPlanes ) {
		this.dispatchEvent( { type: 'planesdetected', data: frame } );
	}
	this._xrFrame = null;
}
const box = JSON.parse( '{}' );
box[ String( Math.random() ) ] = 1;
const renderer = new Renderer();
const xr = new XRManager( renderer );
const session = new EventDispatcher();
console.log( 'layer', xr.createLayer( { type: 'quad', width: 4 } ) );
xr.setSession( session );
xr.addEventListener( 'planesdetected', ( e ) => console.log( 'planes', e.data.id ) );
xr.setAnimationLoop( ( time, frame ) => console.log( 'loop', time, frame.id ) );
const inputSource = { handedness: 'left' };
session.dispatchEvent( { type: 'inputsourceschange', added: [ inputSource ], removed: [] } );
session.addEventListener( 'select', ( event ) => console.log( 'select index', xr._controllerInputSources.indexOf( event.inputSource ) ) );
session.dispatchEvent( { type: 'select', inputSource, frame: null } );
renderer._animation.tick( 16, { id: 7, detectedPlanes: true } );
renderer._animation.tick( 32, undefined );
console.log( 'frame', xr._xrFrame === null );
console.log( 'sources', xr._controllerInputSources.length, 'connected', xr._controllers[ 0 ].connected );
session.dispatchEvent( { type: 'end' } );
console.log( 'ended', xr._session !== null, session._listeners.select.length );
console.log( 'keys', Object.keys( box ).length );
export {};
