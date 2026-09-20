//! expect: 7
function go(): void {
  const boxed: unknown = 7
  const back = boxed as number
  console.log(String(back))
}
go()
