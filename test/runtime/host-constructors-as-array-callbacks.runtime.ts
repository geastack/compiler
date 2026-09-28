//! expect: 3 a,b 1,0,2 true,false
// `strings.map(Number)`, `values.filter(Boolean)`, `numbers.map(String)`: a
// host constructor handed to an Array method is the function it is when
// called -- ToNumber, ToBoolean, ToString -- applied to each element.
const parts = ['1', '2'].map(Number)
const kept = ['a', '', 'b'].filter(Boolean)
const texts = [1, 0, 2].map(String)
const flags = [1, 0].map(Boolean)
console.log(parts.reduce((sum, part) => sum + part, 0), kept.join(','), texts.join(','), flags.join(','))
