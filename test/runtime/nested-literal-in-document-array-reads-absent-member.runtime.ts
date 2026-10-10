// A database client's `insertMany([...])` hands document literals whose nested objects
// (`meta: { owner, dims: { w, h } }`) are typed `any` by the Document index;
// its binary-document serializer's size calculation then reads `value.toWire` off every nested
// value. Reading a member a nested literal does not have is `undefined`.
type Doc = { [key: string]: any }

function visit(value: any): string {
  if (value !== null && typeof value === 'object') {
    if (typeof value.toWire === 'function') return 'wire'
    if (Array.isArray(value)) return `[${value.map(visit).join(',')}]`
    return `{${Object.keys(value)
      .map((key) => `${key}:${visit(value[key])}`)
      .join(',')}}`
  }
  return String(value)
}

function insertMany(docs: ReadonlyArray<Doc>): string {
  return docs.map((doc) => visit(doc)).join(' ')
}

const when = new Date('2024-01-02T03:04:05.006Z')
console.log(
  insertMany([
    { name: 'beta', meta: { owner: 'bob', level: 2, dims: { w: 3, h: 4 } }, created: when },
    { name: 'delta', meta: { owner: 'cy', level: 1, notes: [1, 2, 3] }, tags: ['green'] }
  ])
)

//! expect: {name:beta,meta:{owner:bob,level:2,dims:{w:3,h:4}},created:{}} {name:delta,meta:{owner:cy,level:1,notes:[1,2,3]},tags:[green]}
