// A database client's connection-string option table: each descriptor's
// `transform({ values: [value], options })` takes `values: unknown[]`, so the
// destructured `value` is stored dynamic, and a guard narrows it before
// `{ ...options.readConcern, ...value }` spreads it into a literal.
class Concern {
  level: string
  constructor(level: string) {
    this.level = level
  }

  static fromOptions(options?: { concern?: Concern; level?: string }): Concern | undefined {
    if (options == null) return undefined
    if (options.concern) return options.concern
    if (options.level) return new Concern(options.level)
    return undefined
  }
}

interface Resolved {
  concern?: Concern
}

interface Descriptor {
  transform?: (args: { name: string; options: Resolved; values: unknown[] }) => unknown
}

function isRecord<T extends readonly string[]>(value: unknown, requiredKeys: T): value is Record<T[number], any>
function isRecord(value: unknown, requiredKeys: readonly string[]): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false
  const keys = Object.keys(value as Record<string, any>)
  return requiredKeys.every((key) => keys.includes(key))
}

const TABLE = {
  concern: {
    transform({ values: [value], options }) {
      if (value instanceof Concern || isRecord(value, ['level'] as const)) {
        return Concern.fromOptions({ ...options.concern, ...value } as any)
      }
      throw new Error(`Concern must be an object, got ${JSON.stringify(value)}`)
    }
  }
} as Record<string, Descriptor>

const run = (value: unknown, options: Resolved): string => {
  const values: unknown[] = []
  values.push(value)
  const result = TABLE['concern']!.transform!({ name: 'concern', options, values })
  return result instanceof Concern ? result.level : String(result)
}

//! expect: plain=majority
console.log(`plain=${run({ level: 'majority' }, {})}`)
//! expect: instance=linearizable
console.log(`instance=${run(new Concern('linearizable'), {})}`)
//! expect: refused=Concern must be an object, got 5
try {
  run(5, {})
} catch (error) {
  console.log(`refused=${(error as Error).message}`)
}
// The later, dynamic source's `level` overwrites the earlier typed
// source's own `level` (a `Concern` instance's one own key).
//! expect: override=later
console.log(`override=${run({ level: 'later' }, { concern: new Concern('earlier') })}`)
//! expect: kept=earlier
console.log(`kept=${run(new Concern('earlier'), { concern: new Concern('ignored') })}`)
//! expect: null=refused
try {
  console.log(run(null, {}))
} catch (error) {
  console.log(`null=refused`)
}
