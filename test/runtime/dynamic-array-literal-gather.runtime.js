//! dynamic-fallback
//! expect: 3 true true 3
//! emitted-has: gea::runtime::iterator::appendGather

// Assigning this literal as an ordinary constructor's replacement prototype
// is the explicit dynamic-fallback boundary that selects a dynamic carrier for
// the literal itself. JSON.parse supplies a genuinely dynamic iterable; this
// is therefore the exact `array-literal:dynamic(dynamic-gather)` path, not an
// array-object result with dynamic elements.
function Holder() {}
const source = JSON.parse('[null,null,3]')
const gathered = [...source]
Holder.prototype = gathered
console.log(gathered.length, gathered[0] === null, gathered[1] === null, gathered[2])
