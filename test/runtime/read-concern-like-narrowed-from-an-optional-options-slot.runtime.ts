// A read concern option that is either the class itself, a `{ level }`
// object, or a bare level string, read off an optional options object and
// narrowed by `instanceof`, `typeof` and `'level' in` in turn.

export {}

const ReadConcernLevel = Object.freeze({
  local: 'local',
  majority: 'majority',
  linearizable: 'linearizable',
  available: 'available',
  snapshot: 'snapshot'
} as const)

type ReadConcernLevel = (typeof ReadConcernLevel)[keyof typeof ReadConcernLevel]

type ReadConcernLike = ReadConcern | { level: ReadConcernLevel } | ReadConcernLevel

class ReadConcern {
  level: ReadConcernLevel | string

  constructor(level: ReadConcernLevel) {
    this.level = ReadConcernLevel[level] ?? level
  }

  static fromOptions(options?: { readConcern?: ReadConcernLike; level?: ReadConcernLevel }): ReadConcern | undefined {
    if (options == null) {
      return
    }

    if (options.readConcern) {
      const { readConcern } = options
      if (readConcern instanceof ReadConcern) {
        return readConcern
      } else if (typeof readConcern === 'string') {
        return new ReadConcern(readConcern)
      } else if ('level' in readConcern && readConcern.level) {
        return new ReadConcern(readConcern.level)
      }
    }

    if (options.level) {
      return new ReadConcern(options.level)
    }
    return
  }

  static get MAJORITY(): 'majority' {
    return ReadConcernLevel.majority
  }

  toJSON(): { level: string } {
    return { level: this.level }
  }
}

interface CollectionOptions {
  readConcern?: ReadConcernLike
  readPreference?: string
}

interface DbOptions extends CollectionOptions {
  dbName?: string
  level?: ReadConcernLevel
}

class Db {
  readonly readConcern: ReadConcern | undefined
  constructor(options: DbOptions) {
    this.readConcern = ReadConcern.fromOptions(options)
  }
}

class Collection {
  readonly readConcern: ReadConcern | undefined
  constructor(db: Db, options?: CollectionOptions) {
    this.readConcern = ReadConcern.fromOptions(options) ?? db.readConcern
  }
}

const show = (concern: ReadConcern | undefined): string => (concern === undefined ? 'none' : JSON.stringify(concern.toJSON()))

const shared = new ReadConcern('majority')
console.log(show(ReadConcern.fromOptions()), show(ReadConcern.fromOptions({})))
console.log(show(ReadConcern.fromOptions({ readConcern: shared })), ReadConcern.fromOptions({ readConcern: shared }) === shared)
console.log(show(ReadConcern.fromOptions({ readConcern: 'local' })))
console.log(show(ReadConcern.fromOptions({ readConcern: { level: 'snapshot' } })))
console.log(show(ReadConcern.fromOptions({ level: 'available' })))
const db = new Db({ dbName: 'app', readConcern: { level: 'linearizable' } })
console.log(show(db.readConcern), show(new Collection(db).readConcern), show(new Collection(db, { readConcern: 'local' }).readConcern))
console.log(ReadConcern.MAJORITY)

//! expect: none none
//! expect: {"level":"majority"} true
//! expect: {"level":"local"}
//! expect: {"level":"snapshot"}
//! expect: {"level":"available"}
//! expect: {"level":"linearizable"} {"level":"linearizable"} {"level":"local"}
//! expect: majority
