// A database client's bulk `replaceOne` hands `op.replaceOne.replacement` --
// a `WithoutId<TSchema>`, named fields plus `[key: string]: any` -- to
// `makeUpdateStatement(filter, update: Document | Document[], ...)`. The
// replacement is one document: it enters the union's document arm with every
// own property it has.
interface Replacement {
  title?: string
  revision?: number
  [key: string]: any
}

type WireDocument = { [key: string]: any }

function describe(update: WireDocument | WireDocument[]): string {
  if (Array.isArray(update)) return `pipeline:${update.length}`
  return Object.keys(update)
    .map((key) => `${key}=${String(update[key])}`)
    .join(',')
}

const replacement: Replacement = { title: 't', revision: 2 }
replacement.extra = true
const plain: { title: string } = { title: 'p' }
const pipeline: WireDocument[] = [{}, {}]
console.log(describe(replacement), describe(plain), describe(pipeline))
//! expect: title=t,revision=2,extra=true title=p pipeline:2
