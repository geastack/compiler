// ECMA-262 23.1.3.5 / .19 / .38: `entries()`, `keys()` and `values()` return an
// Array Iterator that re-reads the length every step. A database client walks
// `for (const [index, host] of hosts.entries())`.

const hosts: string[] = ['a:1', 'b:2']
for (const [index, host] of hosts.entries()) {
  //! expect: 0=a:1
  //! expect: 1=b:2
  console.log(index + '=' + host)
}

const counts: number[] = [5, 6]
const pairs: string[] = []
for (const [i, n] of counts.entries()) pairs.push(i + ':' + n)
//! expect: pairs=0:5,1:6
console.log('pairs=' + pairs.join(','))

const grown: number[] = [1]
const seen: number[] = []
for (const value of grown.values()) {
  seen.push(value)
  if (value < 3) grown.push(value + 1)
}
//! expect: live=1,2,3
console.log('live=' + seen.join(','))

const indices: number[] = []
for (const k of hosts.keys()) indices.push(k)
//! expect: keys=0,1
console.log('keys=' + indices.join(','))
