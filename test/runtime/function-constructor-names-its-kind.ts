//! expect: Function AsyncFunction false true
// fastify's `if (cb.constructor.name === 'AsyncFunction')` over a callback the
// caller hands it: a function's `constructor` is the intrinsic its
// declaration's kind names, read off the function object at run time.
function kindOf(cb: () => unknown): string {
  return cb.constructor.name
}
function isAsync(cb: () => unknown): boolean {
  return cb.constructor.name === 'AsyncFunction'
}
console.log(
  kindOf(() => 1),
  kindOf(async () => 1),
  isAsync(function () {
    return 2
  }),
  isAsync(async function () {
    return 2
  })
)
