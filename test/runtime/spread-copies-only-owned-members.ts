//! expect: true false n false true
//! expect: false false true x {} {"name":"x"}
// `CopyDataProperties` copies the source's OWN keys. fastify and ajv write
// `{ ...opts, strict: opts.strict ?? true }` everywhere: a member a later key
// of the literal redefines is never copied, and a member the source only may
// own is copied only when it is there -- an absent one neither throws nor
// arrives as a present `undefined`.
interface Options {
  strict?: boolean
  name?: string
}
type InstanceOptions = Options & { strict: boolean }
const make = (opts: Options): InstanceOptions => ({ ...opts, strict: opts.strict ?? true })
const copy = (opts: Options): Options => ({ ...opts })
const a = make({})
const b = make({ strict: false, name: 'n' })
console.log(a.strict, b.strict, b.name, 'name' in a, 'name' in b)
const c = copy({})
const d = copy({ name: 'x' })
console.log('name' in c, 'strict' in c, 'name' in d, d.name, JSON.stringify(c), JSON.stringify(d))
