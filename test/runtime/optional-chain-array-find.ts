// tsc: `symbol.declarations?.find(isClassLike)` -- `Array.prototype.find` has
// two overloads (a type-guard one and a plain one), and through `?.` the
// chain's short-circuit result carried the member's DECLARED type, both
// overloads, which no calling convention joins; the same access without the
// `?.` certified, because the `[[Get]]`'s own value is callee-aware.
interface Decl {
  readonly kind: number
  readonly name: string
}
interface ClassDecl extends Decl {
  readonly kind: 1
  readonly members: number
}
const isClassLike = (d: Decl): d is ClassDecl => d.kind === 1
const declsOf = (present: boolean): Decl[] | undefined => {
  if (!present) return undefined
  const cls: ClassDecl = { kind: 1, name: 'b', members: 3 }
  return [{ kind: 0, name: 'a' }, cls]
}
const decls = declsOf(true)
const none = declsOf(false)
console.log(decls?.find(isClassLike)?.name)
console.log(none?.find(isClassLike)?.name)
console.log(decls?.find((d) => d.name === 'a')?.kind)
const plain: Decl[] = declsOf(true)!
console.log(plain.find(isClassLike)?.members)
//! expect: b
//! expect: undefined
//! expect: 0
//! expect: 3
