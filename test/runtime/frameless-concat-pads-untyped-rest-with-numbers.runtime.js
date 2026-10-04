// @ts-nocheck
// three's TSLCore ShaderNodeProxy: verifyParamsLimit pads its untyped rest
// list with `params.concat( new Array( n ).fill( 0 ) )`. The checker types the
// receiver `any`, so the call has no frame. ECMA-262 23.1.3.2 spreads the Array
// argument, and each number enters the receiver's dynamic element.
// The operands take no `= null` default: under `strict` the checker types such a
// JS parameter `null`, and the padded `0` arriving there is rightly refused.
class Node {

	static get type() {

		return 'Node';

	}

	constructor( nodeType = null ) {

		this.nodeType = nodeType;

	}

}

class JoinNode extends Node {

	static get type() {

		return 'JoinNode';

	}

	constructor( a, b, c ) {

		super( 'vec3' );
		this.nodes = [ a, b, c ];

	}

}

class OperatorNode extends Node {

	static get type() {

		return 'OperatorNode';

	}

	constructor( op, a, b ) {

		super( 'float' );
		this.op = op;
		this.nodes = [ a, b ];

	}

}

const nodeArray = ( array ) => array;

const ShaderNodeProxy = function ( NodeClass, scope = null, factor = null, settings = null ) {

	function assignNode( node ) {

		return node;

	}

	let fn, name = scope, minParams, maxParams;

	function verifyParamsLimit( params ) {

		let tslName;

		if ( name ) tslName = /[a-z]/i.test( name ) ? name + '()' : name;
		else tslName = NodeClass.type;

		if ( minParams !== undefined && params.length < minParams ) {

			console.log( `TSL: "${ tslName }" parameter length is less than minimum required.` );

			return params.concat( new Array( minParams - params.length ).fill( 0 ) );

		} else if ( maxParams !== undefined && params.length > maxParams ) {

			console.log( `TSL: "${ tslName }" parameter length exceeds limit.` );

			return params.slice( 0, maxParams );

		}

		return params;

	}

	if ( scope === null ) {

		fn = ( ...params ) => {

			return assignNode( new NodeClass( ...nodeArray( verifyParamsLimit( params ) ) ) );

		};

	} else {

		fn = ( ...params ) => {

			return assignNode( new NodeClass( scope, ...nodeArray( verifyParamsLimit( params ) ) ) );

		};

	}

	fn.setParameterLength = ( ...params ) => {

		if ( params.length === 1 ) minParams = maxParams = params[ 0 ];
		else if ( params.length === 2 ) [ minParams, maxParams ] = params;

		return fn;

	};

	return fn;

};

// Read directly as well: a static getter reached only through the
// `NodeClass` parameter refuses separately (emit-class-properties.ts).
console.log( Node.type, JoinNode.type, OperatorNode.type );
const vec3 = ShaderNodeProxy( JoinNode ).setParameterLength( 3 );
const add = ShaderNodeProxy( OperatorNode, '+' ).setParameterLength( 2 );
console.log( add( 'p' ).nodes.join( ',' ), add( 'p', 'q' ).op );
const short = vec3( 'x' );
console.log( short.nodes.join( ',' ), short.nodes.length );
const exact = vec3( 'x', 'y', 'z' );
console.log( exact.nodes.join( ',' ) );
const long = vec3( 'x', 'y', 'z', 'w' );
console.log( long.nodes.join( ',' ) );

// A module, as three's files are: a script's `class Node` would name the DOM global.
export {};

//! expect: Node JoinNode OperatorNode
//! expect: TSL: "+" parameter length is less than minimum required.
//! expect: p,0 +
//! expect: TSL: "JoinNode" parameter length is less than minimum required.
//! expect: x,0,0 3
//! expect: x,y,z
//! expect: TSL: "JoinNode" parameter length exceeds limit.
//! expect: x,y,z
