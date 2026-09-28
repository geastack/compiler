// @ts-nocheck
//! expect: 2 1
//! expect: g
// semver's `new RegExp(value, isGlobal ? 'g' : undefined)`: undefined flags
// are the empty flag string.
const make = (value, isGlobal) => new RegExp(value, isGlobal ? 'g' : undefined)
console.log('a1a2'.match(make('\\d', true)).length, 'a1a2'.match(make('\\d', false)).length)
console.log(make('x', true).flags + make('x', false).flags)
