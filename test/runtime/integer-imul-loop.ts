//! expect: imul-loop=-1536508113
//! emitted-has: gea::integerImul(
//! emitted-has: gea::integerBitwiseOr(
//! emitted-lacks: gea::host::Math::imul
//! emitted-lacks: gea::toUint32(
//! emitted-lacks: gea::bitwiseOr(
// The builtin's int32 result bounds the sum, so the entire recurrence stays
// in integer storage. This is shared native code generation, with no Wasm host.
export {}
let value = 31
for (let i = 0; i < 10000; i++) value = (Math.imul(value, 1664525) + 1013904223) | 0
console.log(`imul-loop=${value}`)
