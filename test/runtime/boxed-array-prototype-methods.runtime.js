// @ts-nocheck
//! dynamic-fallback
//! expect: 1 3 true false 4 2 1 3
//! expect: true true 14 14 51413
//! expect: [3,1,4,1,5,9,[10],11] [1,2,[3,[4]]] [1,2,3] [3,6,1,2,4,8,1,2,5,10]
//! expect: [2,3] [1,"a","b","c",4,5] 1 7 [0,-1,"a","b","c",4,5]
//! expect: [5,4,"c","b","a",-1,0] [1,0,0,4] 0 undefined
//! expect: [1,10,9,"a","b",null] [3,2,1]
//! expect: TypeError Reduce of empty array with no initial value
//! expect: function true
// A boxed Array answers the whole of Array.prototype's generic algorithms
// (ECMA-262 23.1.3) through its own [[Get]]/[[Set]]/[[Delete]].
const b = JSON.parse('{}')
b.list = [3, 1, 4, 1, 5]
const l = b.list
console.log(l.indexOf(1), l.lastIndexOf(1), l.includes(4), l.includes(9), l.find((x) => x > 3), l.findIndex((x) => x > 3), l.findLast((x) => x < 4), l.findLastIndex((x) => x === 1))
console.log(l.some((x) => x > 4), l.every((x) => x > 0), l.reduce((a, x) => a + x, 0), l.reduce((a, x) => a + x), l.reduceRight((a, x) => a + String(x), ''))
console.log(JSON.stringify(l.concat([9, [10]], 11)), JSON.stringify(JSON.parse('[1,[2,[3,[4]]]]').flat()), JSON.stringify(JSON.parse('[1,[2,[3]]]').flat(Infinity)), JSON.stringify(l.flatMap((x) => [x, x * 2])))
const s = JSON.parse('[1,2,3,4,5]')
console.log(JSON.stringify(s.splice(1, 2, 'a', 'b', 'c')), JSON.stringify(s), s.shift(), s.unshift(0, -1), JSON.stringify(s))
console.log(JSON.stringify(s.reverse()), JSON.stringify(JSON.parse('[1,2,3,4]').fill(0, 1, 3)), s.at(-1), s.at(99))
console.log(JSON.stringify(JSON.parse('[10,9,1,"b","a",null]').sort()), JSON.stringify(JSON.parse('[3,1,2]').sort((x, y) => y - x)))
try { JSON.parse('[]').reduce((a, x) => a) } catch (e) { console.log(e.name, e.message) }
console.log(typeof Array.prototype.indexOf, 'splice' in JSON.parse('[]'))
