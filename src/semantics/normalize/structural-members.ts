import ts from 'typescript'

import type { IdentityTable } from './identities.js'

/**
 * Which members of an object type a LAYOUT carries.
 *
 * Three modes, and the difference between them is the whole subject of this
 * file:
 *
 * - `all` -- an in-program object literal or a non-ambient declaration. Every
 *   member is written in this program, so every member is storage.
 * - `data-only` -- a CLASS instance, and a declarationless object type. A class
 *   method lives on the prototype; putting it in the instance would claim
 *   per-instance storage the language does not allocate. (`typeof globalThis`
 *   needs the same filter for an unrelated reason: its own `globalThis`
 *   property mentions the type again, and the ambient `var`/`function` bindings
 *   at global scope are checker-flagged `Module`, not `Property`, so filtering
 *   to `Property` is what keeps that walk finite.)
 * - `interface` -- an ambient interface or type alias. See `keeperFor`.
 */
export type MemberMode = 'all' | 'data-only' | 'interface'

/** Which of the two filters a mode selects, given the full member list it will be applied to. */
export type MemberKeeper = (properties: readonly ts.Symbol[], members: 'data-only' | 'interface') => (property: ts.Symbol) => boolean

/** The member rules, bound to the identity table they need to read declarations from. */
export const createMemberRules = (identities: IdentityTable): { readonly keeperFor: MemberKeeper } => {
  const declarationOfSymbol = (property: ts.Symbol): ts.Declaration | null => identities.declarationOfSymbol(property)

  const isDataMember = (property: ts.Symbol): boolean => (property.flags & ts.SymbolFlags.Property) !== 0

  /**
   * A method no layout can carry a slot for.
   *
   * Three reasons, each fail-closed:
   *
   * GENERIC. This is the member `data-only` was written to exclude, and the
   * exclusion is about termination, not implementation: every instantiation of
   * `Promise.then<TResult1, TResult2>` mints a fresh anchor whose return type
   * is a fresh `Promise` of fresh parameters, so walking one never converges.
   *
   * OVERLOADED. A symbol with more than one declaration has more than one call
   * signature, and a field holding it would have to name ONE calling
   * convention. `RegExp`'s `[Symbol.replace]`
   * (`lib.es2015.symbol.wellknown.d.ts`) is the standing case: two signatures
   * differing in whether `replaceValue` is a string or a callback. Carrying it
   * reached the emitter as `unresolved(no primitive joining 2 overload
   * signatures into one calling convention)` and refused the whole record
   * layout -- a member the layout cannot name is not a member the layout can
   * hold, and the honest place to refuse is the USE, which already does.
   *
   * UNIDENTIFIABLE. A symbol whose declaration cannot be found answers no
   * question at all; treating it as uncarriable keeps the walk finite.
   */
  const isUncarriableMethod = (property: ts.Symbol): boolean => {
    if ((property.getDeclarations()?.length ?? 0) > 1) return true
    const declaration = declarationOfSymbol(property)
    if (declaration === null) return true
    if (!ts.isMethodSignature(declaration) && !ts.isMethodDeclaration(declaration)) return true
    return (declaration.typeParameters?.length ?? 0) > 0
  }

  /**
   * A member an ambient *interface* contributes to the layout.
   *
   * `Property` plus every NON-generic method. An interface has no
   * implementation to be missing -- it names a shape, and whoever creates a
   * value of it supplies the members. A program that does supply one stores a
   * callable into that slot: `core/packages/core/runtime/host.ts` builds
   * `const photo: CameraPhoto = { imageId, width, height, orientation,
   * dispose() { image.dispose(id) } }` against an interface declared in
   * `core/packages/core/index.d.ts`. Filtering `dispose` out left the
   * allocation writing a field the record type did not declare -- the
   * object-literal walk and the layout disagreeing, with the layout wrong.
   *
   * Methods no layout can name a slot for stay filtered -- see
   * `isUncarriableMethod`. This is deliberately NOT the rule for
   * a class instance: a class method lives on the prototype, so `isDataMember`
   * alone stays correct there and claiming per-instance storage for it would be
   * a second, opposite defect.
   */
  const isInterfaceMember = (property: ts.Symbol): boolean =>
    isDataMember(property) || ((property.flags & ts.SymbolFlags.Method) !== 0 && !isUncarriableMethod(property))

  /**
   * Whether an interface's methods can be carried AS A SET.
   *
   * All or none, deliberately. A layout either represents the interface
   * faithfully or it is the data-only projection; keeping some methods and
   * silently dropping others is neither, and it is actively worse than either
   * -- it grows the struct with members whose siblings are missing, so the
   * shape claims to be the interface while answering a different member set.
   *
   * The two cases this separates are real. `CameraPhoto`
   * (`core/packages/core/index.d.ts`) is four data properties and one plain
   * `dispose(): void`: nothing is dropped, every member is storage, and an
   * object literal in `runtime/host.ts` really does write all five. `RegExp`
   * (`lib.es5.d.ts`) is the opposite -- `[Symbol.replace]` is overloaded,
   * others are generic -- so its layout is a projection no matter what, and
   * admitting `exec`/`test` into it only dragged `RegExpExecArray` and
   * `RegExpMatchArray` in behind them as native handles for protocols nothing
   * claims. A builtin whose values are not object literals belongs behind a
   * native protocol (v1 carries `RegExp` as `gea::runtime::regex::Pattern`),
   * not in a record; until it is, the data-only projection is the honest
   * answer for it, and this rule reaches that answer without naming it.
   */
  const methodsAreCarriable = (properties: readonly ts.Symbol[]): boolean =>
    properties.every((property) => (property.flags & ts.SymbolFlags.Method) === 0 || !isUncarriableMethod(property))

  const keeperFor = (properties: readonly ts.Symbol[], members: 'data-only' | 'interface'): ((property: ts.Symbol) => boolean) =>
    members === 'interface' && methodsAreCarriable(properties) ? isInterfaceMember : isDataMember
  return { keeperFor }
}
