//! expect: pass

function* g(): Generator<number, void, number> {
  const x: number = yield 1
  const y: number = yield x + 10
  console.log(x, y)
}

const it = g()
const r1 = it.next()
const r2 = it.next(42)
const r3 = it.next(100)

if (r1.value === 1 && r2.value === 52 && r3.done === true) {
  console.log('pass')
} else {
  console.log('fail')
}
