//! expect: true false function
//! emitted-lacks: return x + 8462
function calculate(x: number): number {
  return x + 8462
}
function compare(left: (x: number) => number, right: (x: number) => number): void {
  console.log(left === right, left !== right, typeof left)
}
compare(calculate, calculate)
