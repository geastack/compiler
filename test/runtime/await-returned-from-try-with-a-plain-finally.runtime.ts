//! expect: connect:start sync-after connect:finally connected:true lock:undefined
// `try { await lock; return this } finally { this.lock = undefined }` --
// a database client's `Client.connect`. The finally does not suspend, so it is
// emitted as a scope-exit guard inside the coroutine; the guard must still see
// a live frame when `co_return` leaves the try.
export {}

const log: string[] = []

class Client {
  lock: Promise<Client> | undefined
  connected = false

  async connect(): Promise<Client> {
    if (this.lock === undefined) this.lock = this.open()
    try {
      await this.lock
      return this
    } finally {
      log.push('connect:finally')
      this.lock = undefined
    }
  }

  private async open(): Promise<Client> {
    log.push('connect:start')
    await Promise.resolve()
    this.connected = true
    return this
  }
}

const client = new Client()
const done = client.connect()
log.push('sync-after')
const connected = await done
log.push(`connected:${connected.connected}`)
log.push(`lock:${String(client.lock)}`)
console.log(log.join(' '))
