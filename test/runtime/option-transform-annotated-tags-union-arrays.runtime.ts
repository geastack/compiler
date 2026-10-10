// A database client's `readPreferenceTags` option: the descriptor table types every
// `transform` as `(args: { name; options; values: unknown[] }) => unknown`,
// and this one annotates its own parameter more narrowly -- `values:
// Array<string | Record<string, string>[]>` -- then picks `values[0]` when it
// is an array and otherwise asserts the whole list `as Array<string>`.
interface Tags {
  [key: string]: string
}

interface Resolved {
  label: string
}

interface ClientOptions {
  label?: string
}

interface Descriptor {
  transform?: (args: { name: string; options: Resolved; values: unknown[] }) => unknown
}

function entriesFromString(value: string): [string, string][] {
  return value.split(',').map((pair) => {
    const [k, v] = pair.split(':')
    return [k ?? '', v ?? '']
  })
}

const TABLE = {
  tags: {
    transform({ values, options }: { values: Array<string | Record<string, string>[]>; options: ClientOptions }) {
      const tags: Array<string | Record<string, string>> = Array.isArray(values[0]) ? values[0] : (values as Array<string>)
      const out: Tags[] = []
      for (const tag of tags) {
        const entry: Tags = {}
        if (typeof tag === 'string') {
          for (const [k, v] of entriesFromString(tag)) entry[k] = v
        } else {
          for (const [k, v] of Object.entries(tag)) entry[k] = v
        }
        out.push(entry)
      }
      return `${options.label ?? '-'}=${out
        .map((entry) =>
          Object.entries(entry)
            .map(([k, v]) => `${k}:${v}`)
            .join('+')
        )
        .join('|')}`
    }
  }
} as Record<string, Descriptor>

const run = (first: unknown, second: unknown, options: Resolved): unknown => {
  const values: unknown[] = []
  values.push(first)
  if (second !== undefined) values.push(second)
  return TABLE['tags']!.transform!({ name: 'tags', options, values })
}

// The method is annotated more narrowly than the table's `transform` slot, so
// its parameter is the slot's storage (`bivariant-slot-parameter.ts`): no
// adapter copies `values`, and `tags` -- `values[0]` or `values` itself -- is
// that same boxed-element array, its stated element read out per element.
//! expect: a=dc:ny+rack:1|dc:sf
console.log(run('dc:ny,rack:1', 'dc:sf', { label: 'a' }))
const inner: unknown[] = []
inner.push('dc:ny')
inner.push('rack:2')
//! expect: b=dc:ny|rack:2
console.log(run(inner, undefined, { label: 'b' }))
