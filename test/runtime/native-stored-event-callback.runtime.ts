// @ts-nocheck
//! expect: 7 1 0
//! expect: 7 2 0
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

type DisposeEvent = { type: string; target?: Resource | null }
type Listener = (event: DisposeEvent) => void

class Resource {
  amount = 7
  private listeners = new Map<string, Listener[]>()
  add(type: string, listener: Listener): void {
    let list = this.listeners.get(type)
    if (list === undefined) {
      list = []
      this.listeners.set(type, list)
    }
    list.push(listener)
  }
  fire(event: DisposeEvent): void {
    const list = this.listeners.get(event.type)
    if (list === undefined) return
    event.target = this
    const snapshot = list.slice(0)
    for (let index = 0; index < snapshot.length; index++) snapshot[index](event)
    event.target = null
  }
  dispose(): void {
    this.fire({ type: 'dispose' })
  }
}

class Recorder {
  amount = 0
  calls = 0
  record(value): void {
    this.amount = value
    this.calls++
  }
}

const resource = new Resource()
const recorder = new Recorder()
function released(event): void {
  recorder.record(event.target.amount)
}
resource.add('dispose', released)
const dispatchRecord: DisposeEvent = { type: 'dispose' }
resource.fire(dispatchRecord)
console.log(recorder.amount, recorder.calls, dispatchRecord.target === null ? 0 : 1)
resource.dispose()
console.log(recorder.amount, recorder.calls, dispatchRecord.target === null ? 0 : 1)
