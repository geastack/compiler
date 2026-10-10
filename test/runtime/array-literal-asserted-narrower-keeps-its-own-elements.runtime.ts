// a database client's encrypter, building its internal client:
// `[...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)] as string[]`.
// The assertion narrows the literal's `(string | symbol)[]`; the literal itself
// is still built from both spreads.
interface ClientOptions {
  a?: number
  minPoolSize?: number
  b?: number
}
const options: ClientOptions = { a: 1, minPoolSize: 2, b: 3 }
const cloned: ClientOptions = {}
for (const key of [...Object.getOwnPropertyNames(options), ...Object.getOwnPropertySymbols(options)] as string[]) {
  if (['minPoolSize', 'dbName'].includes(key)) continue
  Reflect.set(cloned, key, Reflect.get(options, key))
}
console.log(JSON.stringify(cloned))
//! expect: {"a":1,"b":3}
