//! dynamic-fallback
//! expect: computed alpha,gamma | 1,3 | alpha=1;gamma=3 | {"alpha":1,"gamma":3} | alpha,gamma | alpha,gamma 3
//! expect: mixed alpha,beta,zeta,eta | 1,5,4,6 | alpha=1;beta=5;zeta=4;eta=6 | {"alpha":1,"beta":5,"zeta":4,"eta":6} | alpha,beta,zeta,eta
//! expect: ints 1,2,10,b,a | 1.5,2,10,1,0.5 | {"1":1.5,"2":2,"10":10,"b":1,"a":0.5} | 1,2,10,b,a
//! expect: built c,a,b | {"c":"C","a":"A","b":"B"}
// computed-key-enumeration.runtime.js under `--dynamic-fallback`.
const key = 'ga' + 'mma'
const o = { alpha: 1 }
o[key] = 3
const oIn = []
for (const k in o) oIn.push(k)
console.log(
  'computed',
  [
    Object.keys(o).join(','),
    Object.values(o).join(','),
    Object.entries(o)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(o),
    Object.getOwnPropertyNames(o).join(','),
    oIn.join(',') + ' ' + o.gamma
  ].join(' | ')
)

const m = { alpha: 1, beta: 2 }
m['z' + 'eta'] = 4
m['b' + 'eta'] = 5
m['e' + 'ta'] = 6
const mIn = []
for (const k in m) mIn.push(k)
console.log(
  'mixed',
  [
    Object.keys(m).join(','),
    Object.values(m).join(','),
    Object.entries(m)
      .map(([k, v]) => k + '=' + v)
      .join(';'),
    JSON.stringify(m),
    mIn.join(',')
  ].join(' | ')
)

const n = { b: 1 }
n[String(10)] = 10
n[String(2)] = 2
n['a' + ''] = 0.5
n[String(1)] = 1.5
console.log(
  'ints',
  [Object.keys(n).join(','), Object.values(n).join(','), JSON.stringify(n), Object.getOwnPropertyNames(n).join(',')].join(' | ')
)

const l = {}
for (const k of ['c', 'a', 'b']) l[k] = k.toUpperCase()
console.log('built', [Object.keys(l).join(','), JSON.stringify(l)].join(' | '))
