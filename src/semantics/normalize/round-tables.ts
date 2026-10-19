import type ts from '#typescript'

type Table = Map<unknown, unknown>

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => entry === b[index]))

/** Every entry equal, in the same order: indistinguishable to any reader, iteration included. */
const sameTable = (a: Table, b: Table): boolean => {
  if (a.size !== b.size) return false
  const theirs = b.entries()
  for (const [key, value] of a) {
    const next = theirs.next()
    if (next.done || next.value[0] !== key || !sameValue(next.value[1], value)) return false
  }
  return true
}

/**
 * Shares a census's lookup tables with the round before it, wherever they
 * state the same thing.
 *
 * The binding fixpoint keeps every round's census alive to the end of
 * normalization (each round is the next one's `upstream`), and a round
 * rebuilds tables that the census inputs barely move: on a 48K-line app every
 * parameter census's call tables and the last two object-bag censuses' write
 * tables were entry-for-entry those of the round before, three copies of each
 * held through production. A table equal to the earlier round's, order
 * included, is replaced by that table; otherwise each list equal to the
 * earlier round's is. Only for tables no reader mutates once the census that
 * built them has returned; keyed per checker, since each round runs over the
 * same one.
 */
export const createRoundTableSharing = <T extends { readonly [name: string]: Table }>(): ((checker: ts.TypeChecker, tables: T) => T) => {
  const previous = new WeakMap<ts.TypeChecker, T>()
  return (checker, tables) => {
    const earlier = previous.get(checker)
    if (earlier === undefined) {
      previous.set(checker, tables)
      return tables
    }
    const shared: { [name: string]: Table } = {}
    for (const [name, table] of Object.entries(tables)) {
      const before = earlier[name]
      if (before === undefined) shared[name] = table
      else if (sameTable(table, before)) shared[name] = before
      else {
        for (const [key, value] of table) {
          if (!Array.isArray(value)) continue
          const list = before.get(key)
          if (list !== value && sameValue(list, value)) table.set(key, list)
        }
        shared[name] = table
      }
    }
    const result = shared as T
    previous.set(checker, result)
    return result
  }
}
