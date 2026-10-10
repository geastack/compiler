// A database client's `readPreference` option transform: a `values: unknown[]` element
// narrowed by `isRecord(value, ['mode'])` is spread twice into
// `{ readPreference: { ...options.readPreference, ...value }, ...value }`,
// and the literal crosses `as any` into `ReadPreference.fromOptions`'s
// `options?: ReadPreferenceFromOptions` parameter.
type Mode = 'primary' | 'secondary' | 'nearest'

interface Hedge {
  enabled?: boolean
}

class Pref {
  mode: Mode
  tags?: string[]
  hedge?: Hedge
  maxStalenessSeconds?: number

  constructor(mode: Mode, tags?: string[], options?: { maxStalenessSeconds?: number | undefined; hedge?: Hedge | undefined }) {
    this.mode = mode
    this.tags = tags
    this.hedge = options?.hedge
    this.maxStalenessSeconds = options?.maxStalenessSeconds
  }

  get preference(): Mode {
    return this.mode
  }

  static primary = new Pref('primary')

  static fromOptions(options?: PrefFromOptions): Pref | undefined {
    if (!options) return undefined
    const readPreference = options.readPreference
    if (readPreference == null) return undefined
    if (typeof readPreference === 'string') {
      return new Pref(readPreference, options.readPreferenceTags, {
        maxStalenessSeconds: options.maxStalenessSeconds,
        hedge: options.hedge
      })
    } else if (!(readPreference instanceof Pref) && typeof readPreference === 'object') {
      const mode = readPreference.mode || readPreference.preference
      if (mode && typeof mode === 'string') {
        return new Pref(mode, readPreference.tags ?? options.readPreferenceTags, {
          maxStalenessSeconds: readPreference.maxStalenessSeconds,
          hedge: options.hedge
        })
      }
    }
    return readPreference as Pref
  }
}

interface PrefOptions {
  maxStalenessSeconds?: number
  hedge?: Hedge
}

interface PrefLikeOptions extends PrefOptions {
  readPreference?: Pref | Mode | { mode?: Mode; preference?: Mode; tags?: string[]; maxStalenessSeconds?: number }
}

interface PrefFromOptions extends PrefLikeOptions {
  readPreferenceTags?: string[]
}

interface Resolved {
  readPreference: Pref
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
  readPreference: {
    transform({ values: [value], options }) {
      if (isRecord(value, ['mode'] as const)) {
        const rp = Pref.fromOptions({
          readPreference: { ...options.readPreference, ...value },
          ...value
        } as any)
        if (rp) return rp
        throw new Error(`Cannot make read preference from ${JSON.stringify(value)}`)
      }
      throw new Error(`Unknown ReadPreference value`)
    }
  }
} as Record<string, Descriptor>

const run = (value: unknown, options: Resolved): string => {
  const values: unknown[] = []
  values.push(value)
  const result = TABLE['readPreference']!.transform!({ name: 'readPreference', options, values })
  return result instanceof Pref ? `${result.mode}:${result.tags?.join(',') ?? '-'}:${result.maxStalenessSeconds ?? '-'}` : String(result)
}

//! expect: secondary:-:-
console.log(run({ mode: 'secondary' }, { readPreference: Pref.primary }))
//! expect: nearest:a,b:-
console.log(run({ mode: 'nearest' }, { readPreference: new Pref('secondary', ['a', 'b']) }))
//! expect: secondary:x:120
console.log(run({ mode: 'secondary', tags: ['x'], maxStalenessSeconds: 120 }, { readPreference: Pref.primary }))
