// A generic method a subclass overrides is instantiated, through the BASE, at
// a type argument nothing ever calls the subclass with. A receiver typed as
// the base still runs whichever class allocated it, so the override needs its
// own copy at that instantiation even though no call is written against it:
// a database client's lazy document's `getNumber` reads `this.get(name, 'bool')`,
// and a `ServerResponse` -- which overrides `get<T>` and is only called at
// `'object'` itself -- must answer that call with its own (wrapping) body.
// The reverse holds too: `Reply.read<'tag'>` is only ever called on a
// `Reply`, and the base's copy at `'tag'` is what its `super.read` runs.
interface Kinds {
  num: number
  flag: boolean
  tag: string
}

class Doc {
  constructor(readonly values: Record<string, number | boolean | string>) {}

  read<const T extends keyof Kinds>(name: string, as: T): Kinds[T] | null {
    const value = this.values[name]
    if (value === undefined) return null
    if (as === 'num' && typeof value !== 'number') throw new Error(`${name} is not num`)
    if (as === 'flag' && typeof value !== 'boolean') throw new Error(`${name} is not flag`)
    return value as Kinds[T]
  }

  asNumber(name: string): number | null {
    const flag = this.read(name, 'flag')
    if (flag !== null) return flag ? 1 : 0
    return null
  }

  count(name: string): number {
    return this.read(name, 'num') ?? -1
  }
}

class Reply extends Doc {
  calls = 0
  override read<const T extends keyof Kinds>(name: string, as: T): Kinds[T] | null {
    this.calls += 1
    try {
      return super.read(name, as)
    } catch (cause) {
      throw new Error(`reply: ${(cause as Error).message}`)
    }
  }
}

const plain = new Doc({ ok: true, n: 3 })
const reply = new Reply({ ok: false, n: 'x', label: 'hi' })
const docs: Doc[] = [plain, reply]
for (const doc of docs) console.log('asNumber=' + doc.asNumber('ok'))
for (const doc of docs) {
  try {
    console.log('count=' + doc.count('n'))
  } catch (error) {
    console.log('caught=' + (error as Error).message)
  }
}
console.log('label=' + reply.read('label', 'tag') + ' calls=' + reply.calls)
//! expect: asNumber=1
//! expect: asNumber=0
//! expect: count=3
//! expect: caught=reply: n is not num
//! expect: label=hi calls=3
export {}
