import ts from 'typescript'
import type { IdentityTable, SpecializationPath } from './identities.js'
import type { InstantiationCensus } from './instantiation.js'
import type { SpecializationCensus } from './specialization.js'

/**
 * What a specialized copy substitutes for a type parameter.
 *
 * This is the one place that answers "given this copy of a generic, what is
 * `T` actually bound to". `structural.ts` asks it from two different branches
 * -- the `TypeParameter` branch, which substitutes directly, and the union
 * branch, which must substitute *before* it can decide the union's own shape
 * (`T | null` with `T` bound to `unknown` is plain `unknown`, because
 * `unknown` absorbs every other member). Keeping both callers on one lookup is
 * what stops those two answers from drifting apart.
 */
export interface TypeParameterSubstitution {
  /** What this copy binds a type parameter's declaration to, or `null` when no enclosing copy binds it. */
  readonly boundByPath: (declaration: ts.Declaration) => ts.Type | null
  /**
   * What binds a type parameter no copy on the path binds: the program-wide
   * instantiation census first, then the sole copy of a function TYPE that
   * owns the parameter. Both branches of `structural.ts` and the path
   * substitution read this one answer, so a cell whose declared type is
   * `EmitFunction` and a value the census copied for `EmitFunction`'s only
   * instantiation cannot disagree about what `T` is.
   */
  readonly bindingOf: (declaration: ts.Declaration) => ts.Type | null
  /**
   * The non-recursive "what does this copy substitute for this type" answer.
   * Returns the type unchanged when it is not a type parameter, has no binding
   * in this copy, or is the polymorphic `this` parameter -- which is never a
   * real substitution target, since its symbol's declaration is the class
   * itself rather than a type-parameter declaration.
   */
  readonly substituteTypeParameter: (candidate: ts.Type) => ts.Type
}

/**
 * Searched innermost first: a parameter shadowed by a nested generic's own
 * parameter of the same declaration cannot happen -- declarations are distinct
 * objects -- but the innermost binding is still the one in scope, and finding it
 * first is what makes nesting compose.
 */
export const createPathBinding =
  (specializations: SpecializationCensus, path: SpecializationPath) =>
  (declaration: ts.Declaration): ts.Type | null => {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const step = path[index]
      if (!step) continue
      const copy = specializations.specializationsOf(step.owner)[step.ordinal]
      const bound = copy?.bindingOf(declaration)
      if (bound) return bound
    }
    return null
  }

/**
 * The substitution one copy performs, stated over a symbol resolver rather than
 * over the whole `IdentityTable`.
 *
 * `identities.ts` needs this same answer while it is still building that table:
 * a name that reaches a generic reaches the copy its own arguments select, and
 * the arguments of a site written inside another generic are only concrete once
 * this substitution has run. One definition is the point -- a second, private
 * copy of the rule is exactly how two authorities over "what is `T` here" drift
 * apart.
 */
export const createPathSubstitution = (
  declarationOfSymbol: (symbol: ts.Symbol) => ts.Declaration | null,
  specializations: SpecializationCensus,
  path: SpecializationPath,
  fallback: (declaration: ts.Declaration) => ts.Type | null = () => null
): ((candidate: ts.Type) => ts.Type) => {
  const boundByPath = createPathBinding(specializations, path)
  const filledByPath = (open: ts.Type): ts.Type | null => {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const step = path[index]
      if (!step) continue
      const filling = specializations.specializationsOf(step.owner)[step.ordinal]?.fillingOf(open)
      if (filling) return filling
    }
    return null
  }
  return (candidate: ts.Type): ts.Type => {
    // A composite the enclosing copy's own call closed -- `T[]` written at a
    // site inside `outer<T>`, `string[]` in the copy `outer(words)` minted.
    // See `Specialization.fillingOf`.
    if (!(candidate.flags & ts.TypeFlags.TypeParameter)) {
      return (candidate.flags & (ts.TypeFlags.Object | ts.TypeFlags.UnionOrIntersection)) !== 0
        ? (filledByPath(candidate) ?? candidate)
        : candidate
    }
    const symbol = candidate.getSymbol()
    const declaration = symbol ? declarationOfSymbol(symbol) : null
    if (!declaration || ts.isClassLike(declaration)) return candidate
    const bound = boundByPath(declaration) ?? fallback(declaration)
    return bound && bound !== candidate ? bound : candidate
  }
}

/**
 * A type parameter owned by a function TYPE -- `type EmitFunction = <T extends
 * Node>(node: T) => void` -- has no body a copy could specialize, so no path
 * step ever binds it, and the instantiation census cannot bind it either when
 * every call through the type happens inside another generic (`emitFn(c)` with
 * `c: Child` records a hole, which that census rightly drops). The
 * specialization census's fixpoint does fill those holes from the enclosing
 * copies, so when it minted exactly ONE copy of the function type, that copy's
 * tuple is the type's only instantiation in the program: the cell declared
 * with the type holds the value specialized on that tuple (`closeOpenValueUses`
 * and the fixpoint's `typeOwners` branch key the value use on it), and the
 * type read at the cell must say the same. Two or more copies fall through to
 * the constraint, which is what the value use then closes over too.
 */
const createSoleTypeCopyBinding =
  (specializations: SpecializationCensus) =>
  (declaration: ts.Declaration): ts.Type | null => {
    if (!ts.isTypeParameterDeclaration(declaration)) return null
    const owner = declaration.parent
    if (!(
      ts.isFunctionTypeNode(owner) ||
      ts.isConstructorTypeNode(owner) ||
      ts.isCallSignatureDeclaration(owner) ||
      ts.isConstructSignatureDeclaration(owner)
    ))
      return null
    // A call/construct signature that is one arm of an OVERLOADED interface
    // or type literal (`interface Respond { <T,U>(v: T, flag?: U): string;
    // <T,U>(v: T, init?: U): string }`) owns its own, textually separate `T` --
    // a distinct declaration per arm even though every arm spells it the same
    // way. "Exactly one copy" is a fact about ONE arm's own recorded calls,
    // never about the callable value as a whole: the checker resolves any one
    // call to exactly one arm, so the arm it picks racks up a copy from that
    // call's own concrete argument while every sibling arm -- never itself
    // selected -- sits at zero and falls through to the constraint below. The
    // two arms then answered `T` differently (the call's own argument shape
    // versus the bare constraint) for what is one physical calling
    // convention, and `sharedAbiOf` (representation/derive.ts) read that as
    // the arms disagreeing at the parameter they in fact agree on --
    // `generic-field-initializer.ts`'s `Respond`, unjoinable at parameter 0.
    // A function TYPE's own signature has no siblings (`type EmitFunction =
    // <T>(...) => void` is the whole type), so this guard is a no-op there:
    // the sole-copy reasoning stays exactly as documented above for the case
    // it was built for, and only turns off where a second arm makes "the
    // type's only instantiation" a claim about one arm rather than the type.
    const container = owner.parent
    if (ts.isInterfaceDeclaration(container) || ts.isTypeLiteralNode(container)) {
      const siblings = container.members.filter((member) =>
        ts.isCallSignatureDeclaration(owner) ? ts.isCallSignatureDeclaration(member) : ts.isConstructSignatureDeclaration(member)
      )
      if (siblings.length > 1) return null
    }
    const copies = specializations.specializationsOf(owner)
    return copies.length === 1 ? (copies[0]?.bindingOf(declaration) ?? null) : null
  }

export const createTypeParameterSubstitution = (
  identities: IdentityTable,
  instantiations: InstantiationCensus,
  specializations: SpecializationCensus,
  path: SpecializationPath
): TypeParameterSubstitution => {
  const soleTypeCopy = createSoleTypeCopyBinding(specializations)
  const bindingOf = (declaration: ts.Declaration): ts.Type | null => instantiations.bindingOf(declaration) ?? soleTypeCopy(declaration)
  return {
    boundByPath: createPathBinding(specializations, path),
    bindingOf,
    substituteTypeParameter: createPathSubstitution(identities.declarationOfSymbol, specializations, path, bindingOf)
  }
}
