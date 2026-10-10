// @ts-nocheck
// `Array.prototype.join.call(arguments, sep)`: a borrowed join over the
// `arguments` object. `Function.prototype.call` types its result `any`, so the
// fresh string the join answers is held as a dynamic value.
function joined() {
  return Array.prototype.join.call(arguments, ':')
}

function described() {
  const text = Array.prototype.join.call(arguments, '-')
  return text + '/' + typeof text + '/' + text.length
}

console.log(joined(1, 'two', true))
console.log(described('a', 2))
console.log('[' + joined() + ']')

//! expect: 1:two:true
//! expect: a-2/string/3
//! expect: []

export {}
