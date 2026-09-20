// `return f()` where `f` returns void, inside a function whose declared
// result is a union admitting `void`: the returned value is `undefined`,
// exactly as a `void` stored anywhere else is.
let exits = 0
function exit(code: number): void {
  exits += code
}

function run(code: number): number | void | string {
  if (code < 0) return 'negative'
  if (code === 0) return exit(7)
  return code * 2
}

console.log(run(-1), run(0), run(3), exits)
