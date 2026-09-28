// @ts-nocheck
//! dynamic-fallback
//! expect: GET,HEAD true/1 false/-1 true false
// find-my-way's method table: `httpMethods.hasOwnProperty(i)` under `for...in`,
// and `httpMethods.includes(method)` with an untyped `method`.
const methods = ['GET', 'HEAD']
const seen = []
for (const i in methods) {
  if (!methods.hasOwnProperty(i)) continue
  seen.push(methods[i])
}
const probe = (method) => methods.includes(method) + '/' + methods.indexOf(method)
console.log(seen.join(), probe(JSON.parse('"HEAD"')), probe(JSON.parse('3')), methods.hasOwnProperty('length'), methods.hasOwnProperty('push'))
