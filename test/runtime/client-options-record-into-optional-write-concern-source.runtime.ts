// A CLIENT'S OPTIONS RECORD HANDED TO `fromOptions(options?: Options | Concern | W)`
// WHOSE OPTIONS ARM IS AN INTERFACE FAMILY'S LAYOUT.
//
// A database client's `ClientBulkWriteExecutor` inherits its write concern with
// `WriteConcern.fromOptions(this.client.s.options)`: the whole `ClientOptions`
// record entering an optional sum whose arms are `WriteConcernOptions`, the
// `WriteConcern` class and the `W` scalars. `WriteConcernOptions` is extended
// by a file bucket's upload-stream options (and others), so it lays out as the
// interface FAMILY's one struct (`semantics/interface-families.ts`), which
// also holds the sibling's `metadata?: Document`. `ClientOptions` carries an
// UNRELATED required `metadata: Promise<ClientMetadata>`, which that field
// cannot hold without boxing.
//
// The pair alone cannot tell this site from one naming the stream options,
// where leaving `metadata` out would read `undefined` for the promise. The
// parameter's declared type can: it names `ConcernOptions`, which never
// declares `metadata`, so the view leaves it absent -- exactly what a lone
// `ConcernOptions` layout would -- and reads every key the member declares
// (`nodes.ts`'s `familyMemberViewFor`). The site that names the member
// declaring the field still refuses
// (`family-member-declaring-unfillable-field-refused.runtime.ts`).
//
// Before the boxed-assertion fallback was retired this pair boxed the record
// and aborted at run time on every call; after, it was refused.

type Level = number | 'majority'

interface ConcernSettings {
  w?: Level
  journal?: boolean
}

class Concern {
  readonly w?: Level
  readonly journal?: boolean
  constructor(w?: Level, journal?: boolean) {
    if (w !== undefined) this.w = w
    if (journal !== undefined) this.journal = journal
  }

  static fromOptions(options?: ConcernOptions | Concern | Level): Concern | undefined {
    if (options == null) return undefined
    let settings: ConcernSettings | Concern | undefined
    if (typeof options === 'string' || typeof options === 'number') settings = { w: options }
    else if (options instanceof Concern) settings = options
    else settings = options.writeConcern
    if (settings === undefined) return undefined
    return new Concern(settings.w, settings.journal)
  }
}

interface ConcernOptions {
  writeConcern?: Concern | ConcernSettings
}

// A second member of `ConcernOptions`'s interface family: the family lays out
// ONE struct holding every member's fields, so `metadata?: Document` is a
// field of the `ConcernOptions` arm too.
interface BucketStreamOptions extends ConcernOptions {
  chunkSizeBytes?: number
  metadata?: { [key: string]: any }
}

function bucketConcern(options: BucketStreamOptions): string {
  return `${options.chunkSizeBytes}:${Concern.fromOptions(options)?.w}`
}

interface ClientLikeOptions {
  hosts: string[]
  appName: string
  retryWrites: boolean
  writeConcern: Concern
  metadata: Promise<{ driver: string }>
}

function inherit(options: ClientLikeOptions): string {
  const concern = Concern.fromOptions(options)
  return concern === undefined ? 'none' : `${concern.w}:${concern.journal}`
}

const majority: ClientLikeOptions = {
  hosts: ['a'],
  appName: 'app',
  retryWrites: true,
  writeConcern: new Concern('majority', true),
  metadata: Promise.resolve({ driver: 'a' })
}
const one: ClientLikeOptions = {
  hosts: [],
  appName: 'b',
  retryWrites: false,
  writeConcern: new Concern(1),
  metadata: Promise.resolve({ driver: 'b' })
}
console.log(inherit(majority))
console.log(inherit(one))
console.log(Concern.fromOptions(2)?.w)
console.log(Concern.fromOptions() === undefined)
console.log(majority.writeConcern.w)
console.log(bucketConcern({ chunkSizeBytes: 255, writeConcern: { w: 3 } }))
//! expect: majority:true
//! expect: 1:undefined
//! expect: 2
//! expect: true
//! expect: majority
//! expect: 255:3
