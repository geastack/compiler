// A database client's `FindOperation` (and its
// `ListCollectionsOperation`) narrows an options
// field to `never` so TypeScript lets it delete the key but not assign it:
//
//   options: FindOptions & { writeConcern?: never }
//   ...
//   this.options = { ...options }
//   delete this.options.writeConcern
//
// The intersection leaves the record no `writeConcern` field at all, so the
// key the delete names can only be an own property the generated record's
// expando table holds -- and removing it from there is the delete.
interface WriteConcern {
  w: number
}
interface CommandOptions {
  comment?: string
  writeConcern?: WriteConcern
}
interface FindOptions extends Omit<CommandOptions, 'writeConcern'> {
  limit?: number
}

class FindOperation {
  options: FindOptions & { writeConcern?: never }
  constructor(options: FindOptions) {
    this.options = { ...options }
    delete this.options.writeConcern
  }
}

const operation = new FindOperation({ comment: 'c', limit: 2 })
//! expect: false c 2
console.log('writeConcern' in operation.options, operation.options.comment, operation.options.limit)
