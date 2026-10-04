// @ts-nocheck
//! expect: sum 30 70
//! expect: concat 3px px3 ab
//! expect: mixed 2 1 NaN 1null
//! expect: valueOf 42 str:7
// WebGLBackend's scissor resolve: `const { x, y, width, height } =
// renderContext.scissorValue` destructures an untyped object, so both sides of
// `x + width` are dynamic. ECMA-262 13.15.3 ApplyStringOrNumericBinaryOperator:
// ToPrimitive both (left first), concatenate if either is a String, otherwise
// ToNumeric and add.
const blit = (/** @type {number} */ a, /** @type {number} */ b) => console.log('sum', a, b)
const renderContext = { scissorValue: JSON.parse('{"x":10,"y":30,"width":20,"height":40}') }
const { x, y, width, height } = renderContext.scissorValue
blit(x + width, y + height)
const parsed = JSON.parse('[3,"px",true,null,"a","b",1,2]')
console.log('concat', parsed[0] + parsed[1], parsed[1] + parsed[0], parsed[4] + parsed[5])
const undef = JSON.parse('{}').missing
console.log('mixed', parsed[6] + parsed[2] + '', parsed[6] + parsed[3], parsed[6] + undef, parsed[6] + '' + parsed[3])
const boxed = JSON.parse('{}')
boxed.valueOf = () => 40
const two = JSON.parse('2')
const tagged = JSON.parse('{}')
tagged.toString = () => 'str:'
const seven = JSON.parse('7')
console.log('valueOf', boxed + two, tagged + seven)
