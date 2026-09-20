//! expect: pass

function* g(): Generator<number, string, unknown> {
  let caught = false
  try {
    yield 1
    yield 2
  } catch (e) {
    caught = true
  }
  return caught ? 'caught' : 'not-caught'
}

const it = g()
const r1 = it.next()
const r2 = it.throw(new Error('boom'))

if (r1.value === 1 && r1.done === false && r2.value === 'caught' && r2.done === true) {
  console.log('pass')
} else {
  console.log('fail')
}
