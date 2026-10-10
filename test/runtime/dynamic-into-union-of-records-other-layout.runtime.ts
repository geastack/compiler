// A generic interface instantiated at two types gets two struct layouts. An
// element of one instantiation's union that passes through an `any` binding and
// is read back as the other's union must find its arm by shape, not abort.
interface Doc {
  [key: string]: unknown
}
interface Inner<T> {
  document: T
}
type Op<T> = { insertOne: Inner<T> } | { deleteOne: { filter: Doc } } | { replaceOne: { filter: Doc; replacement: T } }

function describe(op: Op<Doc>): string {
  if ('insertOne' in op) return 'insert:' + String(op.insertOne.document['name'])
  if ('deleteOne' in op) return 'delete:' + String(op.deleteOne.filter['id'])
  return 'replace:' + String(op.replaceOne.replacement['name'])
}

function run<T extends Doc>(ops: ReadonlyArray<Op<T>>): string[] {
  const out: string[] = []
  for (const op of ops) {
    const dynamic: any = op
    out.push(describe(dynamic as Op<Doc>))
  }
  return out
}

const ops: Op<{ name: string }>[] = [
  { insertOne: { document: { name: 'a' } } },
  { deleteOne: { filter: { id: 7 } } },
  { replaceOne: { filter: { id: 1 }, replacement: { name: 'b' } } }
]
//! expect: insert:a|delete:7|replace:b
try {
  console.log(run(ops).join('|'))
} catch (error) {
  console.log('threw', (error as Error).message)
}
