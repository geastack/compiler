type Step = (x: number) => number
const steps: Step[] = [(x) => x + 1, (x) => x * 2]
function run(fns: Step[], start: number): number {
  let value = start
  for (let i = 0; i < fns.length; i++) value = fns[i]!(value)
  return value
}
steps.push((x) => x - 3)
console.log(run(steps, 4), steps.length)
//! expect: 7 3
