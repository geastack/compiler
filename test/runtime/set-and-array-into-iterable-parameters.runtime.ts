// A `Set` AND AN ARRAY PASSED WHERE `Iterable<T>` IS DECLARED.
//
// A database client's `setDifference<T>(setA: Iterable<T>, setB: Iterable<T>)`
// is called by its `parseOptions` with a
// `Set<string>` of the provided option keys and a `string[]` of the known
// ones: it copies the first iterable into a new Set and deletes every element
// the second yields. Both arguments are iterated through their own
// `@@iterator`.

function setDifference<T>(setA: Iterable<T>, setB: Iterable<T>): Set<T> {
  const difference = new Set<T>(setA)
  for (const elem of setB) {
    difference.delete(elem)
  }
  return difference
}

const provided = new Set<string>(['tls', 'appname', 'bogus', 'retrywrites'])
const known = ['appName', 'tls', 'retryWrites'].map((s) => s.toLowerCase())

//! expect: unsupported=bogus
console.log(`unsupported=${[...setDifference(provided, known)].join(',')}`)
//! expect: reverse=appname,retrywrites
console.log(`reverse=${[...setDifference(new Set(['appname', 'tls', 'retrywrites']), ['tls'])].join(',')}`)
