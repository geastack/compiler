interface DocumentRecord {
  id: number
  title: string
  tags: string[]
  score: number
}

function ensureBucket(index: Map<string, Set<number>>, tag: string): Set<number> {
  const existing = index.get(tag)
  if (existing) return existing
  const created = new Set<number>()
  index.set(tag, created)
  return created
}

function addDocument(index: Map<string, Set<number>>, records: Map<number, DocumentRecord>, record: DocumentRecord): void {
  records.set(record.id, record)
  const seenTags = new Set<string>()
  for (const tag of record.tags) {
    if (seenTags.has(tag)) continue
    seenTags.add(tag)
    ensureBucket(index, tag).add(record.id)
  }
}

function cloneSet(values: Set<number>): Set<number> {
  const out = new Set<number>()
  for (const value of values) out.add(value)
  return out
}

function intersectInto(target: Set<number>, values: Set<number>): void {
  for (const value of cloneSet(target)) {
    if (!values.has(value)) target.delete(value)
  }
}

function removeAll(target: Set<number>, values: Set<number> | undefined): void {
  if (!values) return
  for (const value of values) target.delete(value)
}

function query(index: Map<string, Set<number>>, records: Map<number, DocumentRecord>, required: string[], banned: string[]): string {
  let current: Set<number> | null = null
  for (const tag of required) {
    const bucket = index.get(tag)
    if (!bucket) return ''
    current = current ? current : cloneSet(bucket)
    intersectInto(current, bucket)
  }
  if (!current) current = new Set<number>()
  for (const tag of banned) removeAll(current, index.get(tag))

  const matches: DocumentRecord[] = []
  for (const id of current) {
    const record = records.get(id)
    if (record) matches.push(record)
  }
  matches.sort((left, right) => right.score - left.score || left.id - right.id)
  return matches.map((record) => record.title + ':' + record.score).join(',')
}

export function main(): string {
  const index = new Map<string, Set<number>>()
  const records = new Map<number, DocumentRecord>()
  const docs: DocumentRecord[] = [
    { id: 1, title: 'atlas', tags: ['compiler', 'runtime', 'portable', 'compiler'], score: 8 },
    { id: 2, title: 'beacon', tags: ['compiler', 'dom', 'browser'], score: 3 },
    { id: 3, title: 'cinder', tags: ['runtime', 'portable', 'collections'], score: 11 },
    { id: 4, title: 'delta', tags: ['compiler', 'portable', 'collections'], score: 11 }
  ]
  for (const doc of docs) addDocument(index, records, doc)

  const portableCompiler = query(index, records, ['compiler', 'portable'], ['dom'])
  const collectionRuntime = query(index, records, ['runtime', 'collections'], [])
  const missing = query(index, records, ['compiler', 'async'], [])
  return portableCompiler + '|' + collectionRuntime + '|missing=' + String(missing === '') + '|tags=' + String(index.size)
}

console.log(main())
