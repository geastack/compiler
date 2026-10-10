// A try/catch nested inside a finally clause, in an async method whose try
// body returns early. The finally clause renders inside a scope guard's
// lambda, so every block the clause jumps to -- the nested try's join and the
// clause's own exit -- has to render inside that lambda too; a database client's cursor
// cleanup emitted `goto block39` / `goto block41` with neither label defined.
//! expect: run0:body,close,done
//! expect: run1:killed,close-fail,done
//! expect: run2:body,done
//! expect: after-nested:inner,outer:after
//! expect: direct:body,fail,after
let log: string[] = []
class Cursor {
  isClosed = false
  isKilled = false
  failClose = false
  async close(): Promise<void> {
    if (this.failClose) throw new Error('close-fail')
    log.push('close')
  }
  async run(): Promise<void> {
    try {
      if (this.isKilled) {
        log.push('killed')
        return
      }
      log.push('body')
    } finally {
      if (!this.isClosed) {
        try {
          await this.close()
        } catch (e) {
          log.push((e as Error).message)
        }
      }
    }
  }
}
// The same dropped join in a try BODY put the code after the nested statement
// outside the enclosing `try`'s braces, beyond the reach of its handler.
function afterNested(fail: boolean): string {
  const seen: string[] = []
  try {
    try {
      if (fail) throw new Error('inner')
      seen.push('none')
    } catch (e) {
      seen.push((e as Error).message)
    }
    if (seen.length > 0) throw new Error('after')
  } catch (e) {
    seen.push('outer:' + (e as Error).message)
  }
  return seen.join(',')
}
// A finally clause whose FIRST statement is the nested try.
async function direct(): Promise<string> {
  const seen: string[] = []
  try {
    seen.push('body')
  } finally {
    try {
      await Promise.reject(new Error('fail'))
    } catch (e) {
      seen.push((e as Error).message)
    }
    seen.push('after')
  }
  return seen.join(',')
}
async function main(): Promise<void> {
  console.log('direct:' + (await direct()))
  console.log('after-nested:' + afterNested(true))
  const a = new Cursor()
  await a.run()
  log.push('done')
  console.log('run0:' + log.join(','))
  log = []
  const b = new Cursor()
  b.isKilled = true
  b.failClose = true
  await b.run()
  log.push('done')
  console.log('run1:' + log.join(','))
  log = []
  const c = new Cursor()
  c.isClosed = true
  await c.run()
  log.push('done')
  console.log('run2:' + log.join(','))
}
void main()
