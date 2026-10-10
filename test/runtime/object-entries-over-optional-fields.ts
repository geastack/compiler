// ECMA-262 20.1.2.5 Object.entries walks EnumerableOwnProperties, and an
// optional field that was never written is not an own key at all -- so the
// array's length is a run-time fact. A database client's
// `Object.entries(options)` over `{ replicaSet?: string; ... }` is the shape.

interface Options {
  host: string
  replicaSet?: string
  port?: number
}

const describe = (o: Options): string =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .join(',')

//! expect: only-host=host=a
console.log('only-host=' + describe({ host: 'a' }))

//! expect: all=host=b,replicaSet=rs0,port=27017
console.log('all=' + describe({ host: 'b', replicaSet: 'rs0', port: 27017 }))

const later: Options = { host: 'c' }
later.port = 1
//! expect: later=host=c,port=1
console.log('later=' + describe(later))

//! expect: count=2
console.log('count=' + Object.entries(later).length)
