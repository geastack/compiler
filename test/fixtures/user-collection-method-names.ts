// The despecialization fix for `flow/value-flow.ts`'s `COLLECTION_KEY_METHODS`/
// `APPEND_METHODS`/`'fill'`: a user class that merely declares its own
// `push`/`unshift`/`fill`/`get`/`set`/`has`/`delete`/`add` methods must never be
// read as though its receiver were a JS Array or a Map/Set/WeakMap/WeakSet,
// purely because the CALL's method name collides with theirs. Before the fix
// these eight calls fed `array-append`/`array-fill`/`collection-key`/
// `collection-value` write edges into `registry`'s own cell from the method
// name alone, admitting a value into a cell the program never fills that way --
// exactly the shape a cache/registry API (a Command/Strategy pattern) takes in
// real code.

class Registry {
  private store: unknown = null

  push(value: unknown): void {
    this.store = value
  }
  unshift(value: unknown): void {
    this.store = value
  }
  fill(value: unknown): void {
    this.store = value
  }
  get(key: string): unknown {
    return key === '' ? null : this.store
  }
  set(key: string, value: unknown): void {
    this.store = key === '' ? this.store : value
  }
  has(key: string): boolean {
    return key !== '' && this.store !== null
  }
  delete(key: string): boolean {
    this.store = key === '' ? this.store : null
    return true
  }
  add(value: unknown): void {
    this.store = value
  }
}

const registry = new Registry()
registry.push(1)
registry.unshift(2)
registry.fill(3)
registry.set('k', 4)
registry.get('k')
registry.has('k')
registry.delete('k')
registry.add(5)
