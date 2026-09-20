//! expect: pass

function* g(): Generator<number, void, unknown> {
  yield 1
  yield 2
}

const it = g()
const r1 = it.next()
const r2 = it.next()
const r3 = it.next()

if (r1.value === 1 && r1.done === false && r2.value === 2 && r2.done === false && r3.done === true && r3.value === undefined) {
  console.log('pass')
} else {
  console.log('fail')
}
