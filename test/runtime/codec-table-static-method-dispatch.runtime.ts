// A static method called through a union of class constructors read out of an
// `as const` table -- a binary-document serializer's extended-JSON
// `deserializeValue`:
// `const c = keysToCodecs[key]; if (c) return c.fromExtendedJSON(value, options)`.
// Each class declares its own `fromExtendedJSON`, with its own parameters (one
// takes the options, one does not); the call runs the selected class's body
// with the arguments that body declares.
interface Options {
  relaxed?: boolean
}
class Int32 {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
  static fromExtendedJSON(doc: { $numberInt: string }, options?: Options): number | Int32 {
    return options && options.relaxed ? parseInt(doc.$numberInt, 10) : new Int32(parseInt(doc.$numberInt, 10))
  }
}
class MinKey {
  get _wiretype(): 'MinKey' {
    return 'MinKey'
  }
  static fromExtendedJSON(): MinKey {
    return new MinKey()
  }
}
class Code {
  readonly code: string
  constructor(code: string) {
    this.code = code
  }
  static fromExtendedJSON(doc: { $code: string }): Code {
    return new Code(doc.$code)
  }
}
const keysToCodecs = { $numberInt: Int32, $minKey: MinKey, $code: Code } as const

function describe(result: unknown): string {
  if (result instanceof Int32) return `Int32(${result.value})`
  if (result instanceof MinKey) return 'MinKey'
  if (result instanceof Code) return `Code(${result.code})`
  return String(result)
}

function deserializeValue(value: any, options: Options = {}): unknown {
  const keys = Object.keys(value).filter((k) => k.startsWith('$')) as (keyof typeof keysToCodecs)[]
  for (const key of keys) {
    const c = keysToCodecs[key]
    if (c) return c.fromExtendedJSON(value, options)
  }
  return value
}

console.log(describe(deserializeValue({ $numberInt: '5' })), describe(deserializeValue({ $numberInt: '6' }, { relaxed: true })))
//! expect: Int32(5) 6
console.log(describe(deserializeValue({ $minKey: 1 })), describe(deserializeValue({ $code: 'x()' })))
//! expect: MinKey Code(x())
