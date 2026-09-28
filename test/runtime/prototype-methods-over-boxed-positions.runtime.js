// @ts-nocheck
//! dynamic-fallback
//! expect: b,c|b|c
//! expect: 2 0 -1 ello ello
// safe-stable-stringify's `keys.slice(value.length)` and ret's
// `str.indexOf(c)`: a boxed position is ToNumber-ed, a boxed search
// ToString-ed, and a boxed undefined end is still the length.
const box = JSON.parse('{"one":1,"search":"c","count":2}')
const keys = ['a', 'b', 'c']
console.log(keys.slice(box.one).join(',') + '|' + keys.slice(box.one, box.count).join(',') + '|' + keys.slice(box.count, box.missing).join(','))
const text = 'abcabc'
console.log(text.indexOf(box.search), text.indexOf('a', box.missing), 'abc'.indexOf(box.missing), 'hello'.slice(box.one), 'hello'.slice(1, box.missing))
