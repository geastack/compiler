// The spread of an open `Document` handed to a CLOSED options shape --
// a database client's `makeUpdateStatement(selector, doc, { ...currentOp, multi: true })`
// against `UpdateOptions & { multi?: boolean }`. The literal keeps every key
// of the document; the members the closed shape names are read out of the
// document's dynamic half, and the rest stay own properties of the value.

interface WireDocument {
  [key: string]: any
}

interface UpdateOptions {
  upsert?: boolean
  hint?: string
  collation?: { locale: string }
}

interface UpdateStatement {
  q: WireDocument
  upsert?: boolean
  multi?: boolean
  hint?: string
}

function buildCurrentOp(upsert: boolean): WireDocument {
  return { selector: { a: 1 }, upsert, hint: 'by_a', batch: 3 }
}

function makeUpdateStatement(filter: WireDocument, options: UpdateOptions & { multi?: boolean }): UpdateStatement {
  const op: UpdateStatement = { q: filter }
  if (typeof options.upsert === 'boolean') op.upsert = options.upsert
  if (options.multi) op.multi = options.multi
  if (options.hint) op.hint = options.hint
  //! expect: batch,hint,multi,selector,upsert
  console.log(Object.keys(options).sort().join(','))
  //! expect: 3 undefined
  console.log((options as WireDocument)['batch'], options.collation)
  return op
}

const currentOp = buildCurrentOp(true)
const statement = makeUpdateStatement(currentOp['selector'], { ...currentOp, multi: true })
//! expect: 1 true true by_a
console.log(statement.q['a'], statement.upsert, statement.multi, statement.hint)
