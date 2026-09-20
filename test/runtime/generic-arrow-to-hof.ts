//! expect: 1 2 1 a c 3
//! expect: cast 1 a
//! emitted-lacks: callAsFunction
// A generic arrow handed to a higher-order function -- TypeScript's own
// `memoizeOne(<T extends JSDocType>(kind: T["kind"]) => ...)` in
// nodeFactory.ts. No call fills the arrow's `T`; the checker propagates it into
// memoizeOne's result and a call through that result lands on the constraint.
// One closure exists at runtime, so its type parameters have exactly one
// filling, the constraint: the census mints that copy (`constraintBindingsOf`)
// and `structural.ts` reads an unbound callable-owned parameter the same way.
// The second case is the generic `x as unknown as T` return the same file is
// full of: the return census must not bind it to the literal's own shape.
interface JSDocType {
  readonly kind: number
  readonly type: string | undefined
}
interface Star extends JSDocType {
  readonly kind: 1
}
interface Nullable extends JSDocType {
  readonly kind: 2
  readonly postfix: boolean
}
function memoizeOne<A extends string | number | boolean | undefined, T>(callback: (arg: A) => T): (arg: A) => T {
  const map = new Map<string, T>()
  return (arg: A) => {
    const key = `${typeof arg}:${arg}`
    let value = map.get(key)
    if (value === undefined && !map.has(key)) {
      value = callback(arg)
      map.set(key, value)
    }
    return value!
  }
}
let made = 0
const createWorker = <T extends JSDocType>(kind: T['kind'], type: T['type']): T => {
  made += 1
  return { kind, type } as unknown as T
}
const getCreate = memoizeOne(
  <T extends JSDocType>(kind: T['kind']) =>
    (type: T['type']) =>
      createWorker<T>(kind, type)
)
const star = getCreate(1)('a')
const nullable = getCreate(2)('b')
const again = getCreate(1)('c')
console.log(star.kind, nullable.kind, again.kind, star.type, again.type, made)
function make<T extends JSDocType>(kind: T['kind'], type: T['type']): T {
  return { kind, type } as unknown as T
}
const s = make<Star>(1, 'a')
console.log('cast', s.kind, s.type)
