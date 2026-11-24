// A literal handed to a constructor typed with a narrower options interface
// arrives as a view of that literal. Spreading it into the pool's own frozen
// options copies every key the literal holds -- including one whose callable
// type has no dynamic adapter, so the copy cannot take the runtime key walk --
// and a later read of a copied class field answers the literal's value.

export {}
class Address {
  constructor(readonly host: string) {}
  toString(): string {
    return this.host
  }
}
type Lookup = (hostname: string, done: (error: Error | null, address: string | string[], family?: number) => void) => void
interface ConnectionOptions {
  hostAddress: Address
  lookup?: Lookup
  noDelay?: boolean
}
interface PoolOptions extends ConnectionOptions {
  maxPoolSize: number
  minPoolSize?: number
}
class Pool {
  readonly options: Readonly<PoolOptions & { connectionType: any }>
  constructor(options: PoolOptions) {
    this.options = Object.freeze({ connectionType: Pool, ...options, maxPoolSize: options.maxPoolSize ?? 10 })
  }
  get address(): string {
    return this.options.hostAddress.toString()
  }
}
function serverPool(address: Address, base: { maxPoolSize: number; noDelay?: boolean }): Pool {
  const poolOptions = { hostAddress: address, ...base }
  return new Pool(poolOptions)
}
const pool = serverPool(new Address('localhost:27017'), { maxPoolSize: 5, noDelay: true })
console.log(pool.address, pool.options.maxPoolSize, pool.options.noDelay, typeof pool.options.lookup)
//! expect: localhost:27017 5 true undefined
