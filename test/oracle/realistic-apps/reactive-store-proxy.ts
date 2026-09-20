//! dynamic-fallback
//! oracle: node
interface Store {
  count: number
  label: string
}
export function main(): string {
  const events: string[] = []
  const target: Store = { count: 0, label: 'init' }
  const store = new Proxy(target, {
    get(t: Store, key: string): unknown {
      events.push('get:' + key)
      return (t as unknown as Record<string, unknown>)[key]
    },
    set(t: Store, key: string, value: unknown): boolean {
      events.push('set:' + key + '=' + String(value))
      ;(t as unknown as Record<string, unknown>)[key] = value
      return true
    }
  })
  store.count = 1
  store.count = store.count + 1
  store.label = 'ready'
  return events.join('|') + '||total=' + (store.count + 10) + '||label=' + store.label
}
console.log(main())
