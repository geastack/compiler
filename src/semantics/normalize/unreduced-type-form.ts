import ts from 'typescript'

/**
 * Whether a type is an UNREDUCED FORM: a conditional, an indexed access, a
 * `keyof`, or a substitution the checker deferred and that no substitution
 * this compiler performs will ever finish.
 *
 * The same thing `isUnusableEvidence` says about `any`/`void`/`never`, said
 * about the other way a type can fail to be one: an unreduced form names a
 * type EXPRESSION, not a type, and no carrier can be derived from an
 * expression. `structural.ts` refuses exactly these at the end of the line --
 * "an anonymous conditional type is still gated on a type parameter" -- and
 * this is that same refusal, moved to where the form is first taken for
 * evidence.
 *
 * It lives in its own module because THREE censuses independently answer "what
 * is the type of this call" by reading a signature's declared return
 * (`parameter-bindings.ts`, `return-bindings.ts`, `local-bindings.ts`), and a
 * generic signature's declared return is exactly such a form. `Reflect.get`'s
 * is `P extends keyof T ? T[P] : any`; nothing on any of those walks binds `T`
 * or `P`, while the checker had already reduced the call itself to `any` (for
 * a key `RegExp` does not declare) or `string` (for `flags`). Publishing the
 * unreduced form is what refused `pattern-native-property-routing.ts` outright.
 * One rule, asked by the census that publishes and by the resolver that
 * consumes -- not a spelling per caller.
 *
 * A BARE TYPE PARAMETER is deliberately NOT one of these, which is what
 * separates this from `open-type-form.ts`'s `isOpenTypeForm` (a different
 * question: whether a RECEIVER is still polymorphic). Inside a monomorphized
 * copy `T` is evidence -- the copy's own mapper substitutes it -- and refusing
 * it took `assign<T extends object>(t, ...args)`'s `hasProperty(arg, p)`
 * argument away from the census, which then bound `map: object` to the vacuous
 * empty record while the copy's ABI declared the instantiated `Opts`. Measured
 * as a lowering refusal on `assign-for-in-generic.ts`. Substitution finishes a
 * type parameter; it does not finish a conditional.
 *
 * Refusing, never reducing: reducing is what the checker already did at the
 * call site, and its answer is what these resolvers fall back to the moment a
 * census declines. Doing it a second time here would be a second authority on
 * one reduction.
 */
export const isUnreducedTypeForm = (type: ts.Type, seen: Set<ts.Type> = new Set()): boolean => {
  if (seen.has(type)) return false
  seen.add(type)
  const deferred = ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Index | ts.TypeFlags.Substitution
  if ((type.flags & deferred) !== 0) return true
  if (type.isUnionOrIntersection()) return type.types.some((member) => isUnreducedTypeForm(member, seen))
  const reference = type as ts.TypeReference
  const args = (type.flags & ts.TypeFlags.Object) !== 0 ? (reference.typeArguments ?? []) : []
  return args.some((argument) => isUnreducedTypeForm(argument, seen))
}
