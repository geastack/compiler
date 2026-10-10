// THE `{}` OF `Object.assign({}, a, b)` WHEN THE CALL'S RESULT IS AN INTERSECTION.
//
// A database client's `resolveOptions<T>` is
// `const result: T = Object.assign({}, options, resolveWireOptions(options, parent))`
// with `options?: T`, and `Client.db` is
// `Object.assign({}, this.options, options)`. The checker types each call as
// an intersection (`T & WireSerializeOptions`, `ClientOptions & DbOptions`) --
// not an object type -- so the fresh `{}` kept its own empty layout and every
// key a source carries had nowhere to go. The target is allocated for the
// call and observed nowhere else; it is laid out as what the call makes of it.
//
// Before, the generic case compiled and SILENTLY dropped every key: the copy
// went to the empty literal's dynamic-property sidecar, and `result: T` then
// viewed the empty struct as a fresh `T` with every optional field absent.
// (Keys are sorted: every key here is a declared field, and a record whose
// keys are all in its layout enumerates in layout order, not in the order the
// copy created them. Only a key outside the layout gives a record a creation
// order -- see `record-sidecar-key-order-*.runtime.ts`.)

interface SerializeOptions {
  raw?: boolean
  checkKeys?: boolean
}

interface CommandOptions extends SerializeOptions {
  comment?: string
  timeoutMS?: number
}

interface FindOptions extends CommandOptions {
  limit?: number
}

const serializeOptionsOf = (options?: SerializeOptions): SerializeOptions => ({ raw: options?.raw ?? false, checkKeys: false })

function resolveOptions<T extends CommandOptions>(options?: T): T {
  const result: T = Object.assign({}, options, serializeOptionsOf(options))
  if (result.timeoutMS === undefined) result.timeoutMS = 30
  return result
}

const plain = resolveOptions<CommandOptions>({ comment: 'ping' })
//! expect: comment=ping timeoutMS=30 raw=false keys=checkKeys,comment,raw,timeoutMS
console.log(`comment=${plain.comment} timeoutMS=${plain.timeoutMS} raw=${plain.raw} keys=${Object.keys(plain).sort().join(',')}`)

const find = resolveOptions<FindOptions>({ limit: 5, raw: true, timeoutMS: 7 })
//! expect: limit=5 timeoutMS=7 raw=true keys=checkKeys,limit,raw,timeoutMS
console.log(`limit=${find.limit} timeoutMS=${find.timeoutMS} raw=${find.raw} keys=${Object.keys(find).sort().join(',')}`)

interface ClientOptions {
  appName: string
  retryWrites: boolean
}

interface DbOptions {
  authSource?: string
}

class Client {
  readonly options: ClientOptions = { appName: 'app', retryWrites: true }

  dbOptions(options?: DbOptions): string {
    options = options ?? {}
    const finalOptions = Object.assign({}, this.options, options)
    return `${finalOptions.appName}/${finalOptions.retryWrites}/${finalOptions.authSource}/${Object.keys(finalOptions).join(',')}`
  }
}

//! expect: app/true/admin/appName,retryWrites,authSource
console.log(new Client().dbOptions({ authSource: 'admin' }))
//! expect: app/true/undefined/appName,retryWrites
console.log(new Client().dbOptions())
