//! expect: closed:true undefined
//! expect: skipped:undefined
//! expect: all:2
//! expect: single:undefined
//! expect: order:close,all,single

// A database client's encrypter `await this._cryptClient?.close()`
// and topology's `await (many ? Promise.all(closes) : close())`: the operand
// is an optional `Promise<void>`, or a union whose one arm is a
// `Promise<void>`. That arm's `awaited()` yields no value, while the result
// cell holds `undefined` (or the other arm's payload), so the arm resolves to
// the `undefined` the language says a `Promise<void>` settles to.

const order: string[] = []

class Client {
  closed = false
  async close(): Promise<void> {
    this.closed = true
    order.push('close')
  }
}

async function closeAll(count: number): Promise<void[]> {
  order.push('all')
  const closes: Promise<void>[] = []
  for (let i = 0; i < count; i++) closes.push(Promise.resolve())
  return Promise.all(closes)
}

async function single(): Promise<void> {
  order.push('single')
}

async function main(client: Client | undefined, missing: Client | undefined): Promise<void> {
  const closed = await client?.close()
  console.log('closed:' + (client?.closed ?? false) + ' ' + String(closed))
  const skipped = await missing?.close()
  console.log('skipped:' + String(skipped))
  for (const many of [true, false]) {
    const settled = await (many ? closeAll(2) : single())
    if (many) console.log('all:' + (settled === undefined ? 'none' : String(settled.length)))
    else console.log('single:' + (settled === undefined ? 'undefined' : 'value'))
  }
  console.log('order:' + order.join(','))
}

main(new Client(), undefined)
