//! expect: off,on
//! expect: idle,open,open.a,open.b
//! expect: threw: compound state "open" has no initial
//! expect: bad initial: z
// A state-machine library's `ensure<T>(value: T | null | undefined): asserts
// value is T`, called inside a generic `index<T>` with an argument typed as a
// CONDITIONAL over that function's own `T` (`ChildStateKey<T['state'],
// string>`). The checker infers the callee's `T` as that conditional, so the
// callee's copy is filled with a type the enclosing copy's substitution never
// closes, and the same conditional types every later read of the field.
type Dict = Record<string, any>
type ChildStateKey<S extends string, Parent extends string> = S extends `${Parent}.${infer Rest}`
  ? Rest extends `${infer Child}.${string}`
    ? Child
    : Rest
  : never

function ensure<T>(value: T | null | undefined, message: () => string): asserts value is T {
  if (value == null) throw new Error(message())
}

interface MachineState<T extends Dict, Parent extends string = string> {
  initial?: ChildStateKey<T['state'], Parent> | undefined
  states?: { [K in ChildStateKey<T['state'], Parent>]?: MachineState<T, `${Parent}.${K}`> } | undefined
}
interface Machine<T extends Dict> {
  states: { [K in T['state']]?: MachineState<T, K> }
}
interface MachineSchema {
  state?: string | undefined
}

function index<T extends MachineSchema>(machine: Machine<T>): string[] {
  const paths: string[] = []
  const visit = (path: string, state: MachineState<T>): void => {
    paths.push(path)
    const children = state.states
    if (!children) return
    ensure(state.initial, () => `compound state "${path}" has no initial`)
    if (!(state.initial in children)) paths.push(`bad initial: ${String(state.initial)}`)
    for (const [key, child] of Object.entries(children)) {
      if (!child) continue
      visit(`${path}.${key}`, child as MachineState<T>)
    }
  }
  for (const [key, state] of Object.entries(machine.states)) {
    if (!state) continue
    visit(key, state as MachineState<T>)
  }
  return paths
}

interface Toggle {
  state: 'off' | 'on'
}
interface Menu {
  state: 'idle' | 'open' | 'open.a' | 'open.b'
}
console.log(index<Toggle>({ states: { off: {}, on: {} } }).join(','))
console.log(index<Menu>({ states: { idle: {}, open: { initial: 'a', states: { a: {}, b: {} } } } }).join(','))
try {
  index<Menu>({ states: { open: { states: { a: {} } } } })
} catch (error) {
  console.log(`threw: ${(error as Error).message}`)
}
const loose = { states: { open: { initial: 'z', states: { a: {} } } } } as unknown as Machine<Menu>
console.log(
  index<Menu>(loose)
    .filter((path) => path.startsWith('bad'))
    .join(',')
)
