//! expect: 3 string number
//! expect: x,y,1
// An array literal whose own element carrier is wider than a spread source's
// (`(string | number)[]` built from a `string[]`): each copied element is
// converted into the literal's element on the way in, the same per-element
// range copy a call's rest pack performs.
const names = ['x', 'y']
const mixed = [...names, 1]
console.log(mixed.length, typeof mixed[0], typeof mixed[2])
console.log(mixed.join(','))
