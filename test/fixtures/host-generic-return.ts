interface DocumentRecord {
  title: string
  [key: string]: string
}

const original: DocumentRecord = { title: 'native' }
const records: { [key: string]: DocumentRecord } = { first: original }
const returned = Object.values(records)[0]
console.log(returned.title)
returned.title = 'shared'
console.log(original.title)
