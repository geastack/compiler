//! expect: pass

let ranFinally: boolean = false

function* g(): Generator<number, string, unknown> {
  try {
    yield 1
    yield 2
  } finally {
    ranFinally = true
  }
  return 'unreachable'
}

const it = g()
const r1 = it.next()
const r2 = it.return('closed')

if (r1.value === 1 && r1.done === false && ranFinally && r2.value === 'closed' && r2.done === true) {
  console.log('pass')
} else {
  console.log('fail')
}
