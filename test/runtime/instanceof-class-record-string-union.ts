// `x instanceof C` over a union of the class, a record type the class does
// not satisfy, and a string -- a database client's `ReadConcernLike` in
// `ReadConcern.fromOptions`. A record arm can only hold an instance of C if
// some C is converted into that record; nothing here does, so the arm answers
// false and the class arm answers true.

const Level = Object.freeze({ local: 'local', majority: 'majority' } as const)
type Level = (typeof Level)[keyof typeof Level]

class Concern {
  level: Level | string
  constructor(level: Level) {
    this.level = level
  }
}

type ConcernLike = Concern | { level: Level } | Level

function fromOptions(options?: { readConcern?: ConcernLike }): Concern | undefined {
  if (options == null) return
  if (options.readConcern) {
    const { readConcern } = options
    if (readConcern instanceof Concern) {
      return readConcern
    } else if (typeof readConcern === 'string') {
      return new Concern(readConcern)
    } else if ('level' in readConcern && readConcern.level) {
      return new Concern(readConcern.level)
    }
  }
  return
}

const direct = new Concern('majority')
//! expect: true majority
console.log(fromOptions({ readConcern: direct }) === direct, fromOptions({ readConcern: direct })?.level)
//! expect: local
console.log(fromOptions({ readConcern: 'local' })?.level)
//! expect: majority
console.log(fromOptions({ readConcern: { level: 'majority' } })?.level)
//! expect: undefined
console.log(fromOptions({}))

// A Concern viewed as a plain document elsewhere -- a database client hands its read
// concern to command builders typed by shape. The view is a different
// carrier from the union's record arm, so that arm still cannot hold one.
function describe(document: { level: string }): string {
  return 'level=' + document.level
}
//! expect: level=majority
console.log(describe(direct))
