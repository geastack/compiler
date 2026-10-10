// Spreading records whose fields are OPTIONAL -- and an optional record --
// into a literal typed as another interface: a database client's
// `CommandOperation.buildOptions` returns `{ ...this.options,
// ...this.wireOptions, timeoutContext, readPreference, session }`, where
// `options` is `OperationOptions & Abortable` and `wireOptions` is optional.
// `CopyDataProperties` copies a key only when the source HAS it, so an
// absent optional field must stay absent in the result.
interface WireOptions {
  raw?: boolean
  promoteLongs?: boolean
}
type Abortable = { signal?: string }
interface OperationOptions extends WireOptions {
  session?: string
  timeoutMS?: number
}
interface ServerCommandOptions extends WireOptions {
  timeoutMS?: number
  session?: string
  signal?: string
  timeoutContext: number
  readPreference: string
}

class Operation {
  wireOptions?: WireOptions
  options: OperationOptions & Abortable
  constructor(options: OperationOptions & Abortable) {
    this.options = options
    this.wireOptions = options.raw === undefined ? undefined : { raw: options.raw }
  }
  buildOptions(timeoutContext: number): ServerCommandOptions {
    return { ...this.options, ...this.wireOptions, timeoutContext, readPreference: 'primary' }
  }
}

const describe = (o: ServerCommandOptions): string =>
  `${o.timeoutContext} ${o.readPreference} ${o.timeoutMS} ${o.session} ${o.signal} ${o.raw} ${'raw' in o} ${'timeoutMS' in o}`

console.log(describe(new Operation({ timeoutMS: 5, session: 's' }).buildOptions(1)))
console.log(describe(new Operation({ raw: true, signal: 'x' }).buildOptions(2)))
//! expect: 1 primary 5 s undefined undefined false true
//! expect: 2 primary undefined undefined x true true false
