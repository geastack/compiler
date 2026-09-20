//! dynamic-fallback
interface Store {
  count: number
  label: string
  dirty: boolean
}

export function main(): string {
  const log: string[] = []
  const initial: Store = { count: 1, label: 'init', dirty: false }
  const store = new Proxy(initial as any, {
    get(target: any, key: string): any {
      log.push('get:' + key)
      return target[key]
    },
    set(target: any, key: string, value: any): boolean {
      log.push('set:' + key + '=' + String(value))
      target[key] = value
      if (key !== 'dirty') target.dirty = true
      return true
    }
  })
  const key = 'count'
  store[key] = store[key] + 2
  store.label = store.label + ':ready'
  store.extra = 'dynamic'
  const keys = Object.keys(store).sort().join(',')
  return 'count=' + store.count + ' label=' + store.label + ' dirty=' + store.dirty + ' keys=' + keys + ' log=' + log.join('|')
}

console.log(main())
