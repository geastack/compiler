// `for...of` OVER THE ARRAY ARM OF `Document | Document[]` AFTER `Array.isArray`.
//
// A database client's `hasAtomicOperators` takes `doc: Document |
// Document[]`, and under `Array.isArray(doc)` iterates it with `for (const
// document of doc)`, recursing per element; otherwise it reads the document's
// keys and answers whether the first one starts with `$`. `Document` is an
// index-signature interface, so the checker's narrowing keeps both arms in
// view; the iteration runs over the array arm the guard proved live.

interface Doc {
  [key: string]: any
}

function hasAtomicOperators(doc: Doc | Doc[], options?: { ignoreUndefined?: boolean }): boolean {
  if (Array.isArray(doc)) {
    for (const entry of doc) {
      if (hasAtomicOperators(entry)) {
        return true
      }
    }
    return false
  }

  const keys = Object.keys(doc)
  if (options?.ignoreUndefined) {
    let allUndefined = true
    for (const key of keys) {
      if (doc[key] !== undefined) {
        allUndefined = false
        break
      }
    }
    if (allUndefined) throw new Error('all atomic operators are undefined')
  }
  return keys.length > 0 && keys[0]!.startsWith('$')
}

const docOf = (key: string): Doc => {
  const made: Doc = {}
  made[key] = 1
  return made
}
const atomic = docOf('$set')
const plain = docOf('a')
const listOf = (...docs: Doc[]): Doc[] => docs

//! expect: single=true plain=false
console.log(`single=${hasAtomicOperators(atomic)} plain=${hasAtomicOperators(plain)}`)
//! expect: list=true none=false empty=false
console.log(
  `list=${hasAtomicOperators(listOf(plain, atomic))} none=${hasAtomicOperators(listOf(plain))} empty=${hasAtomicOperators(listOf())}`
)
