//! expect: A direct number key undefined
//! expect: B local number key undefined
//! expect: C direct 0|1 key undefined
//! expect: D local 0|1 key undefined
interface Words {
  [name: string]: string
}
const words: Words = { a: 'x' }
function consumeA(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeB(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeC(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function consumeD(value: unknown): string {
  return value === undefined ? 'undefined' : 'present ' + String(value)
}
function caseA(index: number): void {
  console.log('A direct number key ' + consumeA(words[index]))
}
function caseB(index: number): void {
  const held = words[index]
  console.log('B local number key ' + consumeB(held))
}
function caseC(either: 0 | 1): void {
  console.log('C direct 0|1 key ' + consumeC(words[either]))
}
function caseD(either: 0 | 1): void {
  const held = words[either]
  console.log('D local 0|1 key ' + consumeD(held))
}
for (const run of [() => caseA(7), () => caseB(7), () => caseC(1), () => caseD(1)]) {
  try {
    run()
  } catch (error) {
    console.log('threw', (error as Error).message)
  }
}
