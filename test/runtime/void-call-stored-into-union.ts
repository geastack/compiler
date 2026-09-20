let exits = 0
function exit(code: number): void {
  exits += code
}
let u: number | void = exit(1)
console.log(u, exits)
