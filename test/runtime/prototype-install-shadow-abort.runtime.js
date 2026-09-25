// @ts-nocheck
//! expect-abort
//! expect: before float
// An install through a run-time key that names a method the class declares
// would lose to the declared method on every read, so it stops the program
// by name when it runs instead of being silently ignored.
import { ExtNode } from './_prototype-install-nodes.js'
import { addChaining } from './_prototype-install-chaining.js'

const node = new ExtNode('float')
console.log('before', node.getNodeType())
addChaining('getNodeType', (x) => x)
console.log('after', node.getNodeType())
