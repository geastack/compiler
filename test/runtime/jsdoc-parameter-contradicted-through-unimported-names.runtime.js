// @ts-nocheck
//! expect: true true
//! expect: var_b var_slot
// A `@param` tag the program's own calls contradict, where the call and the
// tag are both read through names their files never import: three's
// `Node.getShared( builder )` calls `builder.getNodeFromHash( hash )` with a
// string under `@param {NodeBuilder} builder`, from a file that imports no
// `NodeBuilder`, into `@param {number} hash`; `UniformNode` passes itself to
// `getVarFromNode`, tagged `{VarNode}` in a file that imports no `VarNode`.
// The compilation reads both names program-wide, so the calls it sees are the
// calls that decide what the parameter holds.
import { Builder, VarSlot } from './_late-jsdoc-builder.js'
import { Entry } from './_late-jsdoc-entry.js'

const builder = new Builder()
const a = new Entry('a')
const b = new Entry('b')
a.register(builder)
console.log(String(a.getShared(builder) === a) + ' ' + String(b.getShared(builder) === b))
console.log(b.varName(builder) + ' ' + builder.getVarFromNode(new VarSlot('slot')))
