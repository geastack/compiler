// A generic method a subclass overrides, called through a receiver typed as
// the base with several instantiations. A database client's lazy
// document's `get<T>` is overridden by `ServerResponse.get<T>` (wrapping
// serializer errors), and
// `this.get('cursor', WireType.object)?.get('atClusterTime', WireType.timestamp)`
// reads a nested document -- typed as the base -- at another instantiation.
interface TypeOf {
  num: number
  str: string
  doc: Doc
}

class Doc {
  fields: Map<string, number | string | Doc>
  constructor(fields: Map<string, number | string | Doc>) {
    this.fields = fields
  }
  get<const T extends keyof TypeOf>(name: string, as: T): TypeOf[T] | null {
    const value = this.fields.get(name)
    if (value === undefined) return null
    return this.toJSValue(value, as)
  }
  // The binary-document serializer's shape: the conversion answers `any`, which the generic signature
  // then states per instantiation.
  private toJSValue(value: number | string | Doc, as: keyof TypeOf): any {
    if (as === 'num' && typeof value === 'number') return value
    if (as === 'str' && typeof value === 'string') return value
    if (as === 'doc' && value instanceof Doc) return value
    throw new Error(`${String(value instanceof Doc ? 'doc' : value)} is not ${as}`)
  }
  label(): string {
    return 'doc'
  }
}

class Reply extends Doc {
  override get<const T extends keyof TypeOf>(name: string, as: T): TypeOf[T] | null {
    try {
      return super.get(name, as)
    } catch (cause) {
      throw new Error(`server response: ${(cause as Error).message}`)
    }
  }
  override label(): string {
    return 'response'
  }
  get cursorId(): number | null {
    return this.get('cursor', 'doc')?.get('id', 'num') ?? null
  }
}

const inner = new Doc(
  new Map<string, number | string | Doc>([
    ['id', 42],
    ['ns', 'db.coll']
  ])
)
const nested = new Reply(new Map<string, number | string | Doc>([['id', 7]]))
const response = new Reply(
  new Map<string, number | string | Doc>([
    ['cursor', inner],
    ['ok', 1],
    ['nested', nested]
  ])
)
console.log(response.cursorId, response.get('ok', 'num'), response.get('cursor', 'doc')?.get('ns', 'str'), response.get('gone', 'str'))
//! expect: 42 1 db.coll null

// The nested value is a Response held where a Doc is typed: its own override runs.
const held: Doc = response.get('nested', 'doc')!
console.log(held.label())
//! expect: response
try {
  held.get('id', 'str')
} catch (error) {
  console.log((error as Error).message)
}
//! expect: server response: 7 is not str
try {
  inner.get('id', 'str')
} catch (error) {
  console.log((error as Error).message)
}
//! expect: 42 is not str
