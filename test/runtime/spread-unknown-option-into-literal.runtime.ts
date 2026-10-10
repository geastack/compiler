// AN `unknown` OPTION VALUE SPREAD AFTER A TYPED OPTION INTO ONE LITERAL.
//
// A database client's connection-string parser resolves `readConcern`/`writeConcern`
// options with `ReadConcern.fromOptions({ ...options.readConcern, ...value }
// as any)`, where `value` comes from `values: unknown[]` and was narrowed by
// `value instanceof ReadConcern || isRecord(value, ['level'])`. Object spread
// is CopyDataProperties: the later source's own enumerable keys overwrite the
// earlier ones, and keys the static type never mentioned are still copied.

class Concern {
  level: string
  constructor(level: string) {
    this.level = level
  }

  static fromOptions(options?: { concern?: Concern; level?: string; w?: number }): Concern | undefined {
    if (options == null) return undefined
    if (options.level) return new Concern(`${options.level}${options.w === undefined ? '' : `/w${options.w}`}`)
    return undefined
  }
}

interface Resolved {
  concern?: Concern
}

function isRecord<T extends readonly string[]>(value: unknown, requiredKeys: T): value is Record<T[number], any>
function isRecord(value: unknown, requiredKeys: readonly string[]): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false
  const keys = Object.keys(value as Record<string, any>)
  return requiredKeys.every((key) => keys.includes(key))
}

function transform(values: unknown[], options: Resolved): Concern | undefined {
  const [value] = values
  if (value instanceof Concern || isRecord(value, ['level'] as const)) {
    return Concern.fromOptions({ ...options.concern, ...value } as any)
  }
  throw new Error(`Concern must be an object, got ${JSON.stringify(value)}`)
}

const one = (value: unknown): unknown[] => {
  const values: unknown[] = []
  values.push(value)
  return values
}

//! expect: plain=majority
console.log(`plain=${transform(one({ level: 'majority' }), {})?.level}`)
// `...value` copies `w` too: the guard's `Record<'level', any>` view is a lower
// bound on the live value's keys, not the layout of its box.
//! expect: extra=[local/w2]
console.log(`extra=[${transform(one({ level: 'local', w: 2 }), { concern: new Concern('available') })?.level}]`)
//! expect: instance=linearizable
console.log(`instance=${transform(one(new Concern('linearizable')), {})?.level}`)
//! expect: refused=Concern must be an object, got 5
try {
  transform(one(5), {})
} catch (error) {
  console.log(`refused=${(error as Error).message}`)
}

// A key the guard and every target type never mention still survives the copy:
// the spread source is the live box, not the guard's `Record<'level', any>`.
function copyKeys(values: unknown[]): string {
  const [value] = values
  if (isRecord(value, ['level'] as const)) {
    const copy = { ...{ first: 1 }, ...value }
    return `${Object.keys(copy).join(',')} ${JSON.stringify(copy)}`
  }
  return 'none'
}
//! expect: unnamed=first,level,extra {"first":1,"level":"a","extra":true}
console.log(`unnamed=${copyKeys(one({ level: 'a', extra: true }))}`)
