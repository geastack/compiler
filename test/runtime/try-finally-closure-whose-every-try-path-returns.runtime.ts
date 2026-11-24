// `() => { try { return f(...) } finally { close() } }`: every path through
// the try returns, so the statement never completes normally and nothing
// follows it. The C++ body ends with the finally clause's pending rethrow;
// it must say that control cannot fall past it, or the function ends with no
// return (-Wreturn-type, and undefined behaviour if it were ever reached).

export {}
const closed: string[] = []
function close(name: string): void {
  closed.push(name)
}
function parse(text: string): number {
  if (text === '') throw new Error('empty')
  return Number(text)
}
const guarded =
  (name: string) =>
  (text: string): number => {
    try {
      return parse(text) * 2
    } finally {
      close(name)
    }
  }
const read = guarded('a')
let failure = ''
try {
  read('')
} catch (error) {
  failure = (error as Error).message
}
console.log(read('21'), failure, closed.join(','))
//! expect: 42 empty a,a
