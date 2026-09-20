//! expect: pass

function* g(): Generator<number, number, unknown> {
  yield 1
  yield 2
  return 23
}

const it = g()
const r1 = it.next()
const r2 = it.next()
const r3 = it.next()

if (r1.value === 1 && r1.done === false && r2.value === 2 && r2.done === false && r3.value === 23 && r3.done === true) {
  console.log('pass')
} else {
  console.log('fail')
}
