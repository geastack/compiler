//! expect: ab 2 0
// A JSDoc type names a class only inside a generic argument
// (`@param {Array<Part>}`, `@param {?Array<Part>}`) in a file that never
// imports it: three's `Bindings.js` under `@param {Array<BindGroup>}` and
// `LightingContextNode.js` under `@param {?Array<LightingNode>}`. The checker
// read the name as an error type, so the callee laid the array out with a
// boxed element while this file, which imports the class, lays it out with a
// class element: one array, two carriers. The name is brought into scope from
// the one module that declares it.
import Part from './_jsdoc-generic-name-part.js';
import { countOf, labelsOf } from './_jsdoc-generic-name-list.js';

const parts = [ new Part( 'a' ), new Part( 'b' ) ];
console.log( labelsOf( parts ), countOf( parts ), countOf( null ) );
