// A generic method a subclass overrides is read at several instantiations:
// each copy is its own virtual family, and a read dispatches through the copy
// whose convention it holds (a lazy wire-document reader's `get` / `ServerResponse.get`).
const Kind = Object.freeze({ long: 18, bool: 8, object: 3 } as const)

type TypeOf = {
  [Kind.long]: bigint
  [Kind.bool]: boolean
  [Kind.object]: Doc
}

class Doc {
  constructor(readonly values: Record<string, unknown>) {}

  get<const T extends keyof TypeOf>(name: string | number, as: T, required?: boolean): TypeOf[T] | null
  get<const T extends keyof TypeOf>(name: string | number, as: T, required: true): TypeOf[T]
  get<const T extends keyof TypeOf>(name: string | number, as: T, required?: boolean): TypeOf[T] | null {
    const value = this.values[String(name)]
    if (value === undefined) {
      if (required === true) throw new Error(`missing ${name}`)
      return null
    }
    if (as === Kind.long && typeof value !== 'bigint') return null
    if (as === Kind.bool && typeof value !== 'boolean') return null
    if (as === Kind.object && !(value instanceof Doc)) return null
    return value as TypeOf[T]
  }

  getNumber(name: string): number | null {
    const maybeBool = this.get(name, Kind.bool)
    const bool = maybeBool == null ? null : maybeBool ? 1 : 0
    const maybeLong = this.get(name, Kind.long)
    const long = maybeLong == null ? null : Number(maybeLong)
    return bool ?? long
  }
}

class Reply extends Doc {
  override get<const T extends keyof TypeOf>(name: string | number, as: T, required?: false): TypeOf[T] | null
  override get<const T extends keyof TypeOf>(name: string | number, as: T, required: true): TypeOf[T]
  override get<const T extends keyof TypeOf>(name: string | number, as: T, required?: boolean): TypeOf[T] | null {
    try {
      return super.get(name, as, required)
    } catch (cause) {
      throw new Error(`wrapped: ${(cause as Error).message}`)
    }
  }

  get concernCode(): number | null {
    return this.get('concern', Kind.object)?.getNumber('code') ?? null
  }
}

const inner = new Doc({ code: 50n, flag: true })
const response = new Reply({ concern: inner, n: 7n })
console.log(response.concernCode, inner.getNumber('flag'), response.getNumber('n'), response.getNumber('none'))
const docs: Doc[] = [inner, response]
for (const doc of docs) console.log(String(doc.get('n', Kind.long)), doc.get('flag', Kind.bool))
try {
  response.get('missing', Kind.long, true)
} catch (error) {
  console.log((error as Error).message)
}
//! expect: 50 1 7 null
//! expect: null true
//! expect: 7 null
//! expect: wrapped: missing missing
export {}
