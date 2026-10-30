//! expect: 0 0
//! expect: a undefined
// A state-machine library's `runIfFn<T>(v: T | undefined, ...a: T extends
// Fn ? Parameters<T> : never)`, called inside a generic class with a value
// typed `Partial<S['props']> | (() => Partial<S['props']>)`. The checker
// infers the callee's `T` as that union and evaluates the conditional for
// the function arm only: the `Partial<S['props']>` arm names the class's `S`,
// so its part of the rest parameter and of the result stays a deferred
// conditional. No image of the callee's copy closes it. The class's copy
// closes `Partial<S['props']>` to a record, and no record is a function, so
// both conditionals are their false branch.
type Fn = (...a: any[]) => void
const count = (...values: unknown[]): number => values.length
const restLength = <T>(v: T | undefined, ...a: T extends Fn ? Parameters<T> : never): number => (v === undefined ? -1 : count(...a))
const settled = <T>(
  v: T | undefined,
  ...a: T extends Fn ? Parameters<T> : never
): T extends Fn ? NonNullable<ReturnType<T>> : NonNullable<T> => {
  const res: any = a.length === 0 ? v : undefined
  return res
}
interface Schema {
  props: { id: string; label?: string }
}
class Machine<S extends Schema> {
  private readonly source: Partial<S['props']> | (() => Partial<S['props']>)
  constructor(source: Partial<S['props']> | (() => Partial<S['props']>)) {
    this.source = source
  }
  restLength(): number {
    return restLength(this.source)
  }
  props(): Partial<S['props']> {
    return settled(this.source)
  }
}
const plain = new Machine<Schema>({ id: 'a' })
const lazy = new Machine<Schema>(() => ({ id: 'b' }))
console.log(plain.restLength(), lazy.restLength())
console.log(plain.props().id, plain.props().label)
