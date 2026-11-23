// A generic options resolver copies its options into a fresh object viewed as
// `T`, so `T`'s record is a live view target. One caller's `T` is a spread
// literal with no `session` or `raw`; reading those keys off it is the
// ordinary [[Get]], which answers `undefined` for that literal.

export {}
class Session {
  constructor(readonly name: string) {}
  inTransaction(): boolean {
    return this.name === 'tx'
  }
}
class WriteConcern {
  constructor(readonly w: number) {}
  static fromOptions(options?: { w?: number }): WriteConcern | undefined {
    return options?.w === undefined ? undefined : new WriteConcern(options.w)
  }
}
interface BSONOptions {
  raw?: boolean
}
interface CommandOperationOptions extends BSONOptions {
  session?: Session
  timeoutMS?: number
  readConcern?: string
}
interface Parent {
  timeoutMS?: number
  readConcern?: string
}
function resolveOptions<T extends CommandOperationOptions>(parent: Parent | undefined, options?: T): T {
  const result: T = Object.assign({}, options, { raw: options?.raw ?? false })
  const timeoutMS = options?.timeoutMS ?? parent?.timeoutMS
  const session = options?.session
  if (session?.inTransaction()) console.log('in transaction', session.name)
  if (timeoutMS != null) result.timeoutMS = timeoutMS
  return result
}
interface BucketOptions {
  w?: number
  bucketName?: string
  chunkSizeBytes?: number
  timeoutMS?: number
}
const DEFAULTS: { bucketName: string; chunkSizeBytes: number } = { bucketName: 'fs', chunkSizeBytes: 255 }
class Bucket {
  options: { bucketName: string; chunkSizeBytes: number; writeConcern: WriteConcern | undefined; timeoutMS?: number }
  constructor(parent: Parent, options?: BucketOptions) {
    this.options = resolveOptions(parent, { ...DEFAULTS, ...options, writeConcern: WriteConcern.fromOptions(options) })
  }
}
const find = resolveOptions<CommandOperationOptions>({ readConcern: 'local' }, { session: new Session('tx'), timeoutMS: 3 })
console.log(find.timeoutMS, find.session?.name)
const b = new Bucket({ timeoutMS: 9, readConcern: 'majority' }, { w: 2, bucketName: 'img' })
console.log(b.options.bucketName, b.options.chunkSizeBytes, b.options.writeConcern?.w, b.options.timeoutMS)
//! expect: in transaction tx
//! expect: 3 tx
//! expect: img 255 2 9
