//! expect: 3
//! expect: 1,2,3
// An intrinsic array callback whose declared parameter is WIDER than the
// array's element: the element must be injected into the parameter's union at
// the callback boundary, not passed as-is.
const label = (x: number | string): string => (typeof x === 'number' ? String(x) : x)
const nums: number[] = [1, 2, 3]
const out = nums.map(label)
console.log(out.length)
console.log(out.join(','))
