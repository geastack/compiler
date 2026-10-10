// A database client's connection-string OPTIONS table, `{ ... } as
// Record<keyof ClientOptions, OptionDescriptor>`: the slot types every `transform` as
// `(args: { name; options; values: unknown[] }) => unknown`, and an entry
// STATES a narrower destructured parameter (method parameter bivariance) and
// returns a concrete class. Every call reaches the method through the slot, so
// its parameter is the slot's storage: `values` is the caller's own array --
// the same identity, and every write through it lands in the caller's -- and
// the stated types are checked reads of it.
class Preference {
  mode: string
  tags: Record<string, string>[]
  constructor(mode: string, tags: Record<string, string>[]) {
    this.mode = mode
    this.tags = tags
  }
}

interface Options {
  preference?: Preference
  label?: string
}

interface ClientOptions {
  preference?: Preference
}

interface Descriptor {
  target?: string
  transform?: (args: { name: string; options: Options; values: unknown[] }) => unknown
}

const entries = (text: string): [string, string][] =>
  text.split(',').map((pair) => {
    const [k, v] = pair.split(':')
    return [k ?? '', v ?? '']
  })

const TABLE = {
  label: {
    target: 'label',
    transform({ values: [value] }): string {
      return String(value).toUpperCase()
    }
  },
  tags: {
    target: 'preference',
    transform({ values, options }: { values: string[]; options: ClientOptions }) {
      const collected: Record<string, string>[] = []
      for (const tag of values) {
        const one: Record<string, string> = {}
        for (const [k, v] of entries(tag)) one[k] = v
        collected.push(one)
      }
      return new Preference(options.preference?.mode ?? 'primary', collected)
    }
  },
  same: {
    transform({ values }: { values: string[] }) {
      values.push('seen')
      return values.length
    }
  }
} as Record<string, Descriptor>

const setOption = (options: Options, name: string, values: unknown[]): unknown => {
  const descriptor = TABLE[name]
  if (descriptor === undefined || !descriptor.transform) return undefined
  const result = descriptor.transform({ name, options, values })
  if (descriptor.target === 'preference') options.preference = result as Preference
  if (descriptor.target === 'label') options.label = result as string
  return result
}

const options: Options = {}
const labels: unknown[] = []
labels.push('x')
setOption(options, 'label', labels)
const tags: unknown[] = []
tags.push('dc:ny,rack:1')
tags.push('dc:sf')
setOption(options, 'tags', tags)
console.log(options.label, options.preference?.mode, JSON.stringify(options.preference?.tags))
//! expect: X primary [{"dc":"ny","rack":"1"},{"dc":"sf"}]

const mine: unknown[] = []
mine.push('a')
const returned = setOption(options, 'same', mine)
console.log(returned, mine.length, mine[1])
//! expect: 2 2 seen
