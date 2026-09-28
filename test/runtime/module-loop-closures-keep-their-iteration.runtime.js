// @ts-nocheck
//! dynamic-fallback
//! expect: a,b,c a!,b!,c! A B
// find-my-way installs `Router.prototype[method]` in a module-level `for...in`;
// each installed function keeps its own iteration's `const`.
const names = ['a', 'b', 'c']
const first = []
for (const i in names) { const m = names[i]; first.push(() => m) }
const second = []
for (const n of names) { const m = n + '!'; second.push(() => m) }
const table = {}
for (const i in names) {
  const m = names[i]
  table[m] = function () { return m.toUpperCase() }
}
console.log(first.map((f) => f()).join(), second.map((f) => f()).join(), table.a(), table.b())
