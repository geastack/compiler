// A wide options bag (three extending interfaces, ~135 optional fields of mixed
// types, like a database client's) spread behind 1-4 leading keys. The result's key order
// is observable (Object.keys, JSON.stringify) and must match node: prefix keys
// first in literal order (a prefix key the source also holds keeps its prefix
// place with the source's value), then the source's own keys in its order; an
// absent source key is not created; later writes to the result keep working.
type Tag = { mode: string }
interface OptsA {
  a0?: number
  a1?: string
  a2?: boolean
  a3?: string[]
  a4?: Tag
  a5?: number
  a6?: string
  a7?: boolean
  a8?: string[]
  a9?: Tag
  a10?: number
  a11?: string
  a12?: boolean
  a13?: string[]
  a14?: Tag
  a15?: number
  a16?: string
  a17?: boolean
  a18?: string[]
  a19?: Tag
  a20?: number
  a21?: string
  a22?: boolean
  a23?: string[]
  a24?: Tag
  a25?: number
  a26?: string
  a27?: boolean
  a28?: string[]
  a29?: Tag
  a30?: number
  a31?: string
  a32?: boolean
  a33?: string[]
  a34?: Tag
  a35?: number
  a36?: string
  a37?: boolean
  a38?: string[]
  a39?: Tag
  a40?: number
  a41?: string
  a42?: boolean
  a43?: string[]
  a44?: Tag
}
interface OptsB {
  b0?: number
  b1?: string
  b2?: boolean
  b3?: string[]
  b4?: Tag
  b5?: number
  b6?: string
  b7?: boolean
  b8?: string[]
  b9?: Tag
  b10?: number
  b11?: string
  b12?: boolean
  b13?: string[]
  b14?: Tag
  b15?: number
  b16?: string
  b17?: boolean
  b18?: string[]
  b19?: Tag
  b20?: number
  b21?: string
  b22?: boolean
  b23?: string[]
  b24?: Tag
  b25?: number
  b26?: string
  b27?: boolean
  b28?: string[]
  b29?: Tag
  b30?: number
  b31?: string
  b32?: boolean
  b33?: string[]
  b34?: Tag
  b35?: number
  b36?: string
  b37?: boolean
  b38?: string[]
  b39?: Tag
  b40?: number
  b41?: string
  b42?: boolean
  b43?: string[]
  b44?: Tag
}
interface OptsC {
  c0?: number
  c1?: string
  c2?: boolean
  c3?: string[]
  c4?: Tag
  c5?: number
  c6?: string
  c7?: boolean
  c8?: string[]
  c9?: Tag
  c10?: number
  c11?: string
  c12?: boolean
  c13?: string[]
  c14?: Tag
  c15?: number
  c16?: string
  c17?: boolean
  c18?: string[]
  c19?: Tag
  c20?: number
  c21?: string
  c22?: boolean
  c23?: string[]
  c24?: Tag
  c25?: number
  c26?: string
  c27?: boolean
  c28?: string[]
  c29?: Tag
  c30?: number
  c31?: string
  c32?: boolean
  c33?: string[]
  c34?: Tag
  c35?: number
  c36?: string
  c37?: boolean
  c38?: string[]
  c39?: Tag
}
interface Wide extends OptsA, OptsB, OptsC {
  timeoutMS?: number
  numberToSkip?: number
  numberToReturn?: number
  checkKeys?: boolean
  mode?: string
}

// Source whose keys are in layout order (no log), and one whose keys left it.
function layoutSource(i: number): Wide {
  return { a0: i, a3: ['x'], b1: 's', c2: true }
}
function loggedSource(i: number): Wide {
  const o: Wide = {}
  o.c2 = true
  o.b1 = 's'
  o.a3 = ['x']
  o.a0 = i
  return o
}
function spread1(options: Wide): Wide {
  return { timeoutMS: 30, ...options }
}
function spread3(options: Wide): Wide {
  return { numberToSkip: 0, numberToReturn: -1, checkKeys: false, ...options }
}
function spread4(options: Wide): Wide {
  return { mode: 'm', numberToSkip: 0, timeoutMS: 7, a0: -1, ...options }
}
function show(o: Wide): string {
  return Object.keys(o).join(',') + ' ' + JSON.stringify(o)
}
const lay = layoutSource(1)
const log = loggedSource(2)
const none: Wide = {}
const holds: Wide = { timeoutMS: 5, checkKeys: true, c5: 3 }
console.log(show(spread1(lay)))
console.log(show(spread1(log)))
console.log(show(spread1(none)))
console.log(show(spread1(holds)))
console.log(show(spread3(lay)))
console.log(show(spread3(log)))
console.log(show(spread3(holds)))
console.log(show(spread4(lay)))
console.log(show(spread4(log)))
console.log(show(spread4(holds)))
const mutated = spread3(log)
mutated.b6 = 'late'
mutated.a0 = 99
delete mutated.numberToSkip
mutated.numberToSkip = 4
console.log(show(mutated))
const again = spread1(mutated)
again.c0 = 1
console.log(show(again))
let total = 0
for (let i = 0; i < 3000; i++) {
  const r = i % 2 === 0 ? spread3(i % 4 === 0 ? lay : log) : spread4(i % 3 === 0 ? lay : log)
  total += r.numberToReturn === undefined ? 0 : 1
  if (r.a0 !== undefined) total += 1
}
console.log(total)

// A source whose order is a literal's out-of-order pend, a prefix key the
// source also holds (the prefix place, the source's value), a spread of a
// spread result (its order is still a deferred one), writes and a delete
// before the order is first asked for, and two spreads into one literal.
function pendSource(i: number): Wide {
  return { c2: true, a0: i, b1: 'p' }
}
function twice(first: Wide, second: Wide): Wide {
  return { numberToSkip: 1, ...first, ...second }
}
function viaSpreadResult(options: Wide): Wide {
  return { mode: 'outer', ...spread3(options) }
}
const pend = pendSource(7)
console.log(show(spread3(pend)))
console.log(show(spread4(pend)))
console.log(show(twice(log, pend)))
console.log(show(twice(lay, log)))
console.log(show(twice(holds, log)))
console.log(show(viaSpreadResult(log)))
console.log(show(viaSpreadResult(lay)))
const early = spread3(log)
early.a5 = 1
early.c6 = 'z'
delete early.checkKeys
console.log(show(early))
const reread = spread4(log)
console.log(Object.keys(reread).join(','))
console.log(JSON.stringify(reread))
console.log(
  Object.entries(spread3(log))
    .map((entry) => entry[0])
    .join(',')
)
const entered: string[] = []
for (const key in spread3(log)) entered.push(key)
console.log(entered.join(','))
const copied = { ...spread3(log) }
console.log(Object.keys(copied).join(','))
//! expect: timeoutMS,a0,a3,b1,c2 {"timeoutMS":30,"a0":1,"a3":["x"],"b1":"s","c2":true}
//! expect: timeoutMS,c2,b1,a3,a0 {"timeoutMS":30,"c2":true,"b1":"s","a3":["x"],"a0":2}
//! expect: timeoutMS {"timeoutMS":30}
//! expect: timeoutMS,checkKeys,c5 {"timeoutMS":5,"checkKeys":true,"c5":3}
//! expect: numberToSkip,numberToReturn,checkKeys,a0,a3,b1,c2 {"numberToSkip":0,"numberToReturn":-1,"checkKeys":false,"a0":1,"a3":["x"],"b1":"s","c2":true}
//! expect: numberToSkip,numberToReturn,checkKeys,c2,b1,a3,a0 {"numberToSkip":0,"numberToReturn":-1,"checkKeys":false,"c2":true,"b1":"s","a3":["x"],"a0":2}
//! expect: numberToSkip,numberToReturn,checkKeys,timeoutMS,c5 {"numberToSkip":0,"numberToReturn":-1,"checkKeys":true,"timeoutMS":5,"c5":3}
//! expect: mode,numberToSkip,timeoutMS,a0,a3,b1,c2 {"mode":"m","numberToSkip":0,"timeoutMS":7,"a0":1,"a3":["x"],"b1":"s","c2":true}
//! expect: mode,numberToSkip,timeoutMS,a0,c2,b1,a3 {"mode":"m","numberToSkip":0,"timeoutMS":7,"a0":2,"c2":true,"b1":"s","a3":["x"]}
//! expect: mode,numberToSkip,timeoutMS,a0,checkKeys,c5 {"mode":"m","numberToSkip":0,"timeoutMS":5,"a0":-1,"checkKeys":true,"c5":3}
//! expect: numberToReturn,checkKeys,c2,b1,a3,a0,b6,numberToSkip {"numberToReturn":-1,"checkKeys":false,"c2":true,"b1":"s","a3":["x"],"a0":99,"b6":"late","numberToSkip":4}
//! expect: timeoutMS,numberToReturn,checkKeys,c2,b1,a3,a0,b6,numberToSkip,c0 {"timeoutMS":30,"numberToReturn":-1,"checkKeys":false,"c2":true,"b1":"s","a3":["x"],"a0":99,"b6":"late","numberToSkip":4,"c0":1}
//! expect: 4500
//! expect: numberToSkip,numberToReturn,checkKeys,c2,a0,b1 {"numberToSkip":0,"numberToReturn":-1,"checkKeys":false,"c2":true,"a0":7,"b1":"p"}
//! expect: mode,numberToSkip,timeoutMS,a0,c2,b1 {"mode":"m","numberToSkip":0,"timeoutMS":7,"a0":7,"c2":true,"b1":"p"}
//! expect: numberToSkip,c2,b1,a3,a0 {"numberToSkip":1,"c2":true,"b1":"p","a3":["x"],"a0":7}
//! expect: numberToSkip,a0,a3,b1,c2 {"numberToSkip":1,"a0":2,"a3":["x"],"b1":"s","c2":true}
//! expect: numberToSkip,timeoutMS,checkKeys,c5,c2,b1,a3,a0 {"numberToSkip":1,"timeoutMS":5,"checkKeys":true,"c5":3,"c2":true,"b1":"s","a3":["x"],"a0":2}
//! expect: mode,numberToSkip,numberToReturn,checkKeys,c2,b1,a3,a0 {"mode":"outer","numberToSkip":0,"numberToReturn":-1,"checkKeys":false,"c2":true,"b1":"s","a3":["x"],"a0":2}
//! expect: mode,numberToSkip,numberToReturn,checkKeys,a0,a3,b1,c2 {"mode":"outer","numberToSkip":0,"numberToReturn":-1,"checkKeys":false,"a0":1,"a3":["x"],"b1":"s","c2":true}
//! expect: numberToSkip,numberToReturn,c2,b1,a3,a0,a5,c6 {"numberToSkip":0,"numberToReturn":-1,"c2":true,"b1":"s","a3":["x"],"a0":2,"a5":1,"c6":"z"}
//! expect: mode,numberToSkip,timeoutMS,a0,c2,b1,a3
//! expect: {"mode":"m","numberToSkip":0,"timeoutMS":7,"a0":2,"c2":true,"b1":"s","a3":["x"]}
//! expect: numberToSkip,numberToReturn,checkKeys,c2,b1,a3,a0
//! expect: numberToSkip,numberToReturn,checkKeys,c2,b1,a3,a0
//! expect: numberToSkip,numberToReturn,checkKeys,c2,b1,a3,a0
