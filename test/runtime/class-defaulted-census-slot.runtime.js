//! expect: default 1
//! expect: named 3

class DefaultedOptions {
  /** @param {{ name?: string, count?: number }} [options] */
  constructor(options = {}) {
    console.log(options.name ?? 'default', options.count ?? 1)
  }
}

new DefaultedOptions()
new DefaultedOptions({ name: 'named', count: 3 })
