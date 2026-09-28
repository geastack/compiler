// @ts-nocheck
//! dynamic-fallback
//! expect: 1 -1 true -1 true
// rfdc's `refs.indexOf(cur)` over an Array of boxes: IsStrictlyEqual for
// indexOf, SameValueZero for includes.
const a = JSON.parse('{"k":1}')
const refs = [JSON.parse('{"k":1}'), a, JSON.parse('0')]
const nan = JSON.parse('{"n":null}')
refs.push(nan.n === null ? 0 / 0 : 1)
console.log(refs.indexOf(a), refs.indexOf(JSON.parse('{"k":1}')), refs.includes(JSON.parse('0')), refs.indexOf(0 / 0), refs.includes(0 / 0))
