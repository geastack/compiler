//! expect: indexes:_id_,name_1
//! expect: unique:false,true

// A database client's collection `indexInformation`: `const indexes:
// IndexDescriptionInfo[] = await this.listIndexes(options).toArray()`, where
// `ListIndexesCursor extends AbstractCursor` (its `TSchema` defaults to
// `any`), so `toArray()` answers `Promise<any[]>`. The binding the program
// annotates is typed, and the awaited payload enters it the way any other
// `any[]` initializer enters a typed array binding.

interface IndexDescriptionInfo {
  name: string
  unique?: boolean
}

class AbstractCursor<TSchema = any> {
  private readonly documents: TSchema[]
  constructor(documents: TSchema[]) {
    this.documents = documents
  }
  async toArray(): Promise<TSchema[]> {
    const array: TSchema[] = []
    for (const document of this.documents) array.push(document)
    return array
  }
}

class ListIndexesCursor extends AbstractCursor {}

async function indexInformation(cursor: ListIndexesCursor): Promise<void> {
  const indexes: IndexDescriptionInfo[] = await cursor.toArray()
  console.log('indexes:' + indexes.map((index) => index.name).join(','))
  console.log('unique:' + indexes.map((index) => index.unique === true).join(','))
}

const raw: any = JSON.parse('[{"name":"_id_"},{"name":"name_1","unique":true}]')
indexInformation(new ListIndexesCursor(raw))
