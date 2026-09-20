interface EventPayload {
  kind: string
  amount: number
}

type Listener = (payload: EventPayload) => void

interface ListenerEntry {
  id: number
  once: boolean
  fn: Listener
}

class Emitter {
  listeners: Map<string, ListenerEntry[]> = new Map<string, ListenerEntry[]>()
  nextId = 1

  on(event: string, fn: Listener): number {
    return this.add(event, fn, false)
  }

  once(event: string, fn: Listener): number {
    return this.add(event, fn, true)
  }

  off(event: string, id: number): boolean {
    const current = this.listeners.get(event) ?? []
    const next: ListenerEntry[] = []
    let removed = false
    for (const entry of current) {
      if (entry.id === id) {
        removed = true
      } else {
        next.push(entry)
      }
    }
    this.listeners.set(event, next)
    return removed
  }

  emit(event: string, payload: EventPayload): number {
    const current = this.listeners.get(event) ?? []
    const next: ListenerEntry[] = []
    let delivered = 0
    for (const entry of current) {
      entry.fn(payload)
      delivered += 1
      if (!entry.once) next.push(entry)
    }
    this.listeners.set(event, next)
    return delivered
  }

  count(event: string): number {
    return (this.listeners.get(event) ?? []).length
  }

  private add(event: string, fn: Listener, once: boolean): number {
    const id = this.nextId
    this.nextId += 1
    const current = this.listeners.get(event) ?? []
    current.push({ id, once, fn })
    this.listeners.set(event, current)
    return id
  }
}

export function main(): string {
  const log: string[] = []
  const emitter = new Emitter()
  const keep = emitter.on('data', (payload: EventPayload) => log.push('keep:' + payload.kind + ':' + payload.amount))
  emitter.once('data', (payload: EventPayload) => log.push('once:' + payload.kind + ':' + payload.amount * 10))
  emitter.on('error', (payload: EventPayload) => log.push('err:' + payload.kind))

  const first = emitter.emit('data', { kind: 'alpha', amount: 2 })
  const afterFirst = emitter.count('data')
  const removed = emitter.off('data', keep)
  const second = emitter.emit('data', { kind: 'beta', amount: 3 })
  const errors = emitter.emit('error', { kind: 'fatal', amount: 0 })
  const missing = emitter.off('data', 999)

  return (
    'first=' +
    first +
    ' afterFirst=' +
    afterFirst +
    ' removed=' +
    removed +
    ' second=' +
    second +
    ' errors=' +
    errors +
    ' missing=' +
    missing +
    ' log=' +
    log.join('|')
  )
}

console.log(main())
