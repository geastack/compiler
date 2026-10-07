// @ts-nocheck
//! expect-refusal: the @param type of parameter "hash" of setHashNode was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "hash" of getNodeFromHash was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "node" of getVarFromNode was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A `@param` tag the program's own calls contradict, where the call and the
// tag are both read through names their files never import: three's
// `Node.getShared( builder )` calls `builder.getNodeFromHash( hash )` with a
// string under `@param {NodeBuilder} builder`, from a file that imports no
// `NodeBuilder`, into `@param {number} hash`; `UniformNode` passes itself to
// `getVarFromNode`, tagged `{VarNode}` in a file that imports no `VarNode`.
// The compilation reads both names program-wide, so the calls it sees are the
// calls that decide what the parameter holds.
//
// Reading the names finds the contradictions and erases the tags, but the
// census of the `Builder` methods' callers stays open (the member proof
// cannot close `builder` receivers), so it cannot type `hash` or `node` from
// their complete callers. As `any` they would take the string hash and the
// `Entry` boxed; the three parameters are refused by name instead.
import { Builder, VarSlot } from './_late-jsdoc-builder.js'
import { Entry } from './_late-jsdoc-entry.js'

const builder = new Builder()
const a = new Entry('a')
const b = new Entry('b')
a.register(builder)
console.log(String(a.getShared(builder) === a) + ' ' + String(b.getShared(builder) === b))
console.log(b.varName(builder) + ' ' + builder.getVarFromNode(new VarSlot('slot')))
