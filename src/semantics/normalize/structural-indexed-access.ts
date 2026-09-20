import ts from 'typescript'

/**
 * `T[K]` -- an indexed access the checker left DEFERRED.
 *
 * A concrete one never reaches here: `Rec['a']` and `Rec[keyof Rec]` are both
 * resolved by the checker itself before this layer ever sees them (verified
 * directly -- they arrive already flagged `Number`/`Union`, never
 * `IndexedAccess`). What does reach here is the generic form, `S[keyof S]`
 * written inside a body whose `S` is still a type parameter, and that is
 * exactly what monomorphization exists to answer: inside the copy that binds
 * `S` to a real type, `S[keyof S]` is an ordinary union of that type's own
 * member types.
 *
 * The substitution has to be applied by hand because `structural.ts`'s
 * `TypeParameter` branch only fires when the type IS a parameter. `S[keyof S]`
 * is an `IndexedAccess` whose *operand* is one, so the substitution never
 * descended into it and the whole access fell through to
 * "checker type with flags 8388608 is not modelled" -- one unmodelled form,
 * reported as hundreds of unrelated-looking unresolved carriers, because a
 * bottom carrier propagates into every value derived from it.
 *
 * Nothing here guesses. Every answer is a member the object type declares, read
 * out of the checker after the copy's own binding is substituted in; a key this
 * cannot name resolves to nothing and the caller keeps its honest refusal.
 */

/** The keys an index type names against one object type, or `null` when it names something this cannot enumerate. */
const keysOf = (checker: ts.TypeChecker, objectType: ts.Type, indexType: ts.Type): readonly string[] | null => {
  const constituents = indexType.isUnion() ? indexType.types : [indexType]
  const keys: string[] = []
  for (const constituent of constituents) {
    // `keyof O` names every property O has. Enumerating them is citing O's own
    // declaration, not inventing a key set: `getProperties()` is the same list
    // `keyof` itself is built from.
    if ((constituent.flags & ts.TypeFlags.Index) !== 0) {
      keys.push(...objectType.getProperties().map((property) => property.name))
      continue
    }
    if (constituent.isStringLiteral()) {
      keys.push(constituent.value)
      continue
    }
    // `ToPropertyKey(0)` is the key `"0"`, which is how a tuple's own element
    // is named -- the number literal is a key, not a different kind of access.
    if (constituent.isNumberLiteral()) {
      keys.push(String(constituent.value))
      continue
    }
    // A key this cannot name exactly, but which the CHECKER says is a string,
    // names the whole key set. `for (const k in o) o[k]` inside a generic is
    // the case: TypeScript types `k` as `Extract<keyof T, string>`, a
    // conditional it defers while `T` is open and never reduces afterwards, so
    // the access had no key set at all -- tsc's `assign` and `copyProperties`,
    // and every read and write in their loop bodies. The answer is not a guess:
    // a read through such a key produces one of the object's own members and a
    // write through it must be accepted by any of them, which is precisely what
    // the `keyof` arm above already answers. Asked of the checker rather than
    // matched on a library alias, so a hand-written `T extends string ? T :
    // never` reaches the same answer as `Extract`.
    if (checker.isTypeAssignableTo(constituent, checker.getStringType())) {
      keys.push(...objectType.getProperties().map((property) => property.name))
      continue
    }
    return null
  }
  return keys
}

/**
 * The member types `objectType[indexType]` resolves to, or `null` when the
 * access cannot be resolved from what the object type declares.
 *
 * An empty result is `null` too, deliberately: `O[K]` naming no member at all
 * is not the empty union (which would be `never`, a claim this has no grounds
 * to make) -- it means the key set and the object type disagreed, and the
 * caller should keep refusing.
 */
export const indexedAccessMemberTypes = (checker: ts.TypeChecker, objectType: ts.Type, indexType: ts.Type): readonly ts.Type[] | null => {
  const keys = keysOf(checker, objectType, indexType)
  if (keys === null) return null
  const members: ts.Type[] = []
  for (const key of keys) {
    const property = objectType.getProperty(key)
    if (property) {
      // STATED, and no node to ask a census about either way: this resolves
      // `T[K]`'s member types from `objectType`'s own DECLARED shape --
      // `objectType`/`indexType` are already-resolved `ts.Type`s (see this
      // module's header), not expression nodes, so there is nothing here a
      // parameter/return/write-set census (keyed by node) could be consulted
      // through. `getTypeOfSymbol` is the correct, only question: what does
      // this member's own declaration say.
      members.push(checker.getTypeOfSymbol(property))
      continue
    }
    // A key no named member covers is answered by the object's own index
    // signature when it has one -- `Counts[string]` over
    // `interface Counts { [k: string]: number }` is `number`, declared, not
    // guessed. `getIndexInfosOfType` is asked rather than a key-domain
    // assumption because an object can carry several.
    const index = checker.getIndexInfosOfType(objectType)[0]
    if (index) {
      members.push(index.type)
      continue
    }
    // A key an OBJECT type declares no member for is `undefined`, which is the
    // language's own answer rather than a guess: reading an absent property is
    // `undefined` in JavaScript, and a key that reached here as a literal came
    // from the source, so there is nothing left to disagree about. A key
    // enumerated from `keyof` cannot land here at all -- that list is built
    // from `getProperties()`, so every one of them resolves above.
    //
    // hono is the case this exists for. `class Hono<E extends Env = Env>`'s
    // body reads `E['Bindings']` throughout, and the copy the program actually
    // instantiates binds `E` to `BlankEnv`, which is `{}` -- so `Bindings` is
    // declared by the CONSTRAINT and absent from the ARGUMENT, and the value
    // really is `undefined` at every one of those reads.
    //
    // Only for a real object type. `any`/`unknown` have no members for a
    // different reason -- nothing is known about them, not that the key is
    // missing -- and answering `undefined` there would turn "unknown" into a
    // claim. Those keep the caller's refusal.
    if ((objectType.flags & ts.TypeFlags.Object) === 0) return null
    members.push(checker.getUndefinedType())
  }
  return members.length > 0 ? members : null
}
