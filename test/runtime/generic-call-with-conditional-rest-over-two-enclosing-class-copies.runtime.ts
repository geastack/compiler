//! expect: 0 0 0
//! expect: a c C
// The same call shape as
// generic-call-with-conditional-rest-and-result-over-the-enclosing-class-copy,
// from a class with two copies. The callee's one copy serves both, so the
// deferred conditional is its false branch only because each copy's
// `Partial<S['props']>` is a record.
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
  props: { id: string }
}
interface Labelled {
  props: { id: string; label: string }
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
const labelled = new Machine<Labelled>({ id: 'c', label: 'C' })
const lazy = new Machine<Labelled>(() => ({ id: 'b', label: 'B' }))
console.log(plain.restLength(), labelled.restLength(), lazy.restLength())
console.log(plain.props().id, labelled.props().id, labelled.props().label)
