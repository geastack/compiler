// A database client's `defineAspects` normalizes a
// `symbol | symbol[] | Set<symbol>` with `aspects instanceof Set`. A Set has
// one physical carrier, so each union arm answers from its discriminant.
const READ = Symbol('read')
const RETRY = Symbol('retry')

function defineAspects(aspects: symbol | symbol[] | Set<symbol>): Set<symbol> {
  if (!Array.isArray(aspects) && !(aspects instanceof Set)) {
    aspects = [aspects]
  }
  return new Set(aspects)
}

function kind(value: string | Set<string> | Map<string, number>): string {
  return value instanceof Set ? 'set' : 'other'
}

//! expect: 1 2 2 set other other
console.log(
  defineAspects(READ).size +
    ' ' +
    defineAspects([READ, RETRY]).size +
    ' ' +
    defineAspects(new Set([READ, RETRY])).size +
    ' ' +
    kind(new Set(['a'])) +
    ' ' +
    kind('a') +
    ' ' +
    kind(new Map<string, number>())
)
