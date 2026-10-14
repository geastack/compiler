//! expect: layers=3,5
//! expect: mixed=1,2.5,NaN,0,-4
//! expect: flags=1,0
//! expect: texts=1,2.5,true
//! expect: present=true,false,false
//! expect: indexed=false,true
// `Number` and `String` handed to `map` as the callback are their own
// conversions: ToNumber / ToString of the element, the index and the array
// the callback also receives being ignored (`'3,5'.split(',').map(Number)`).
// And `includes` asked about a `string | null` value over a `string[]`,
// which a type assertion does not unwrap: `null` is never an element.

console.log('layers=' + '3,5'.split(',').map(Number).join(','))
console.log('mixed=' + ['1', '2.5', 'x', '', ' -4 '].map(Number).join(','))
console.log('flags=' + [true, false].map(Number).join(','))
console.log('texts=' + [1, 2.5, true].map(String).join(','))

type Resolution = 'native' | '2160' | '1440'
const resolutions: Resolution[] = ['native', '2160', '1440']
const valid = (value: string | null): boolean => resolutions.includes(value as Resolution)
console.log('present=' + [valid('2160'), valid(null), valid('720')].join(','))
const from = (value: string | null, start: number): boolean => resolutions.includes(value as Resolution, start)
console.log('indexed=' + [from('native', 1), from('1440', 1)].join(','))
