// @ts-nocheck
//! expect: false true b

// The JavaScript binder flags a class carrying a module-scope expando as an
// assignment target, the same flag a CommonJS `module.exports` synthesis has.
// Reading `Node` inside the class must still name the class, not lib.dom's
// ambient `Node`, which no host defines.
import Node from './_class-expando-named-like-dom-global.js'

const first = new Node('a')
Node.captureStackTrace = true
const second = new Node('b')
console.log(first.traced, second.traced, second.kind)
