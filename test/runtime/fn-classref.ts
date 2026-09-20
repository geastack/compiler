//! expect: 7
class Point {
  x: number
  constructor(x: number) {
    this.x = x
  }
}
function go(): void {
  const p = new Point(7)
  const boxed: unknown = p
  const back = boxed as Point
  console.log(String(back.x))
}
go()
