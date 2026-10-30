//! expect: run a: on
//! expect: run b
//! expect: lamp ran 2
//! expect: missing a
//! expect: bare ran 0
//! expect: toggle ran 0
//! expect: 3 number
// A read of a mapped type at a key that is still open in the generic body:
// `{ [K in T['action']]: Fn }[T['action']]`. A state-machine runner's
// `this.machine.implementations?.actions?.[s]`, where `s: T['action']`. The
// checker defers the access while `T` is open, and the mapped object has no
// members the checker resolves until its key set is closed. One copy fills
// `T` with a schema that lists its actions; the other, like a machine with no
// actions, fills it with one that has no `action` key at all.
interface Dict {
  [key: string]: any
}
interface Params<T extends Dict> {
  state: T['state']
}
interface Machine<T extends Dict> {
  implementations?:
    | {
        actions?: { [K in T['action']]: (params: Params<T>) => void } | undefined
      }
    | undefined
}
interface Schema {
  state?: string | undefined
  action?: string | undefined
}

class Runner<T extends Schema> {
  ran = 0
  private machine: Machine<T>
  private state: T['state']
  constructor(machine: Machine<T>, state: T['state']) {
    this.machine = machine
    this.state = state
  }
  run(keys: T['action'][]): void {
    const fns = keys.map((s) => {
      const fn = this.machine.implementations?.actions?.[s]
      if (!fn) console.log('missing ' + String(s))
      return fn
    })
    for (const fn of fns) {
      fn?.({ state: this.state })
      if (fn) this.ran++
    }
  }
}

interface Lamp {
  state: 'off' | 'on'
  action: 'a' | 'b'
}
const lamp = new Runner<Lamp>(
  { implementations: { actions: { a: (params) => console.log('run a: ' + params.state), b: () => console.log('run b') } } },
  'on'
)
lamp.run(['a', 'b'])
console.log('lamp ran ' + lamp.ran)
const bare = new Runner<Lamp>({ implementations: {} }, 'off')
bare.run(['a'])
console.log('bare ran ' + bare.ran)

interface Toggle {
  state: 'off' | 'on'
}
const toggle = new Runner<Toggle>({}, 'off')
toggle.run([])
console.log('toggle ran ' + toggle.ran)

// The same read in a generic function, where the index is the bare key
// parameter. The copy substitutes the key, but the mapped object still has no
// member to read, and the read was laid out as `undefined`.
function show<K extends string>(rows: { [P in K]: number }, key: K): void {
  const value = rows[key]
  console.log(value + 1, typeof value)
}
show<'a' | 'b'>({ a: 1, b: 2 }, 'b')
