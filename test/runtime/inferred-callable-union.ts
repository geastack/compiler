// The parameter annotation leaves the calling convention unstated. The
// callers provide it, and storing the indexed callable must retain it.
let argumentEvaluations = 0
function argument(): number {
  argumentEvaluations++
  return 5
}
function run(callbacks: [Function][], fallback?: () => number): void {
  let selected
  if (callbacks[0]) selected = callbacks[0][0]
  else selected = fallback
  if (selected) console.log(selected(argument()))
}

//! expect: 6
//! expect: 9
const callbacks: [(value: number) => number][] = [[(value: number): number => value + 1]]
const empty: [(value: number) => number][] = []
run(callbacks)
run(empty, (): number => 9)
//! expect: 7
//! expect: 11
//! expect: 4
run([[(value: number): number => value + 2]])
run([], (): number => 11)
console.log(argumentEvaluations)
