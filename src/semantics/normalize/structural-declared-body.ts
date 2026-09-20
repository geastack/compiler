import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralShape } from '../model/structural-types.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'

/**
 * The structure a declared name stands for.
 *
 * A name without a body is a name the later layers cannot lay out, so the body
 * is interned while the nominal identity is still anchored -- a member that
 * refers back to the declaration resolves to the anchor instead of re-entering
 * translation. It lives beside `structural.ts` rather than inside it because
 * everything it needs is already an argument: the table, the walk, and the two
 * shape builders.
 */
export interface DeclaredBodyParts {
  readonly table: StructuralTypeTable
  readonly typeOf: (type: ts.Type) => StructuralTypeId
  readonly signatureOf: (signature: ts.Signature) => import('../model/structural-types.js').SignatureShape
  readonly objectShapeOf: (type: ts.Type, location: ts.Node | null, members: 'all' | 'interface' | 'data-only') => StructuralShape
  /** The array an interface extending `Array`/`ReadonlyArray` is, with its own fields -- see `structural.ts`. */
  readonly arrayHeritageShapeOf: (type: ts.Type, location: ts.Node) => StructuralShape | null
}

/**
 * Which type-level function is still gated, by the name it was written under.
 *
 * The alias symbol is the only handle on a conditional that means anything to a
 * reader: the checker's own rendering of an unresolved conditional is the whole
 * `A extends B ? C : D` text with every argument still open, which is unreadable
 * once several of them nest, and the refusals aggregate to nothing because each
 * nesting depth prints differently. `EnhancedOmit` names the defect.
 */
const conditionalName = (type: ts.Type): string => type.aliasSymbol?.getName() ?? '<anonymous>'

/**
 * Whether `type` is the INSTANCE type TypeScript infers for a pre-`class`
 * JavaScript constructor function -- the "Constructed" type of `function
 * SourceNode(line) { this.line = line }`, named after the function itself.
 *
 * It matters because such a type's members come from two different places and
 * only one of them is storage. `this.line = line` in the body is a per-instance
 * field; `SourceNode.prototype.add = function () {}` is a prototype member every
 * instance merely SEES. The checker already tells them apart -- the first symbol
 * carries `SymbolFlags.Property`, the second `SymbolFlags.Method` -- which is
 * exactly the distinction `structural-members.ts`'s `data-only` mode is written
 * around, and exactly the one a `class` instance already gets. A pre-`class`
 * constructor and a `class` describe the same object, so one rule has to answer
 * for both; laying this one out as `all` made every prototype method a struct
 * field, and nothing ever wrote it (`X.prototype.m = f` lowers to a dynamic set
 * on the prototype object, not a store into the instance), so the field held a
 * null callable and calling it segfaulted.
 *
 * Recognised from the type's own symbol rather than from `declarationLocation`,
 * because the symbol of such an instance type carries BOTH the function and the
 * expando identifiers that assign statics onto it, and which one
 * `declarationOfSymbol` picks is not this rule's question. The type having no
 * call or construct signature of its own is already established by the caller --
 * the function type itself returned a `signature` shape well above here.
 */
const isJsConstructorInstanceType = (type: ts.Type): boolean =>
  (type.getSymbol()?.getDeclarations() ?? []).some(
    (declaration) => (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) && declaration.body !== undefined
  )

export const createDeclaredBodyResolver = ({ table, typeOf, signatureOf, objectShapeOf, arrayHeritageShapeOf }: DeclaredBodyParts) => {
  const declaredBodyOf = (type: ts.Type, declarationLocation: ts.Node): StructuralTypeId | null => {
    // An interface or type alias has no implementation to be missing: it names
    // a shape, and a shape is exactly what a layout is. Whether it was written
    // in a `.ts` or a `.d.ts` changes nothing about that -- what a declaration
    // file changes is where *values* come from, and that boundary is refused
    // where it actually is, at the ambient binding that produces the value.
    // Refusing the type instead left every framework's public record types with
    // no carrier at all, which is a gap reported in the wrong place.
    //
    // Expansion terminates because every cycle in the type graph passes through
    // a declared name, and `typeOf` anchors that name before walking its
    // members: `Promise.then` returning a `Promise` resolves to the anchor
    // already in flight rather than re-entering translation.
    // A UNION is asked first, before its call signatures. TypeScript answers
    // `getCallSignatures()` on a union of function types with the signatures of
    // ALL its arms, which reads here exactly like an overload set -- and an
    // overload set is a claim that one value has several conventions, which
    // `sharedAbiOf` (derive.ts) then has to join or refuse. A union is the
    // opposite claim: several values, each with its own convention, told apart
    // by the arm. hono's `type H = Handler<...> | MiddlewareHandler<...>`
    // (`types.ts:90`) is the case -- two arrow types whose return types differ,
    // refused as "no primitive joining 2 overload signatures" at every site
    // that holds a handler.
    //
    // Only the union. An INTERSECTION of callables really is an overload set
    // (that is how a `.d.ts` spells one across merged declarations), so it
    // keeps the signature path below.
    if (type.isUnion()) return table.intern({ kind: 'union', members: type.types.map(typeOf) })
    const callSignatures = type.getCallSignatures()
    const constructSignatures = type.getConstructSignatures()
    if (callSignatures.length > 0 || constructSignatures.length > 0) {
      return table.intern({
        kind: 'signature',
        call: callSignatures.map((one) => signatureOf(one)),
        construct: constructSignatures.map((one) => signatureOf(one))
      })
    }
    // A method declared in a declaration file is behavior this compiler does not
    // implement: it belongs to whatever ships the type, so putting it in the
    // layout would claim a slot nothing fills. Walking one is also what makes
    // the enumeration diverge -- a generic method's return type is a fresh
    // instantiation, every instantiation is a fresh anchor, and `Promise.then`
    // returning a `Promise` of a new parameter never converges. A use of such a
    // member refuses at the access, which is where the host protocol is actually
    // missing.
    const ambient = declarationLocation.getSourceFile().isDeclarationFile
    if (type.flags & ts.TypeFlags.Object) {
      // Before the object enumeration: an interface that extends an Array is
      // that array, and enumerating it as an object is the defect.
      const array = arrayHeritageShapeOf(type, declarationLocation)
      if (array) return table.intern(array)
      const members = isJsConstructorInstanceType(type) ? 'data-only' : ambient ? 'interface' : 'all'
      return table.intern(objectShapeOf(type, declarationLocation, members))
    }
    // A name for a UNION or an INTERSECTION is a name for a structure that has
    // no layout of its own, and reporting no body at all for it is not honest
    // -- it says the declaration is ambient, which is what `derive.ts` then
    // reports ("is ambient and has no installed host protocol"). hono's
    // `export type Result<T> = [[T, ParamIndexMap][], ParamStash] | [[T,
    // Params][]]` (`router.ts`) is the case: an ordinary source type alias, 32
    // mandatory obligations, refused as though nothing had declared it.
    //
    // The members are walked here rather than by re-entering `typeOf` on the
    // alias itself, which would resolve straight back to the anchor this body
    // belongs to. That is the same walk `translate`'s own union and
    // intersection branches do, minus their substitution and absorption rules,
    // which belong to a type reached WITHOUT a declared name: those rules
    // rewrite the union, and rewriting it under a nominal anchor would make
    // the name and its body disagree.
    if (type.isIntersection()) {
      // The checker's reconciliation of the members rides along; see the
      // `resolved` field's doc comment in `model/structural-types.ts`.
      return table.intern({
        kind: 'intersection',
        members: type.types.map(typeOf),
        declaration: null,
        resolved: table.intern(objectShapeOf(type, declarationLocation, ambient ? 'interface' : 'all'))
      })
    }
    // A CONDITIONAL that never resolved is not an ambient declaration, and
    // saying so out loud is the whole point of this branch. `null` here is read
    // downstream as "the compiler did not define this shape, so a host protocol
    // must carry it" -- which sent every reader of the mongodb probe's compass
    // toward installing bindings for `EnhancedOmit`, `InferIdType`,
    // `OptionalUnlessRequiredId`, `AlternativeType`, `IsAny` and lib.es5's own
    // `Awaited`/`ReturnType`/`Parameters`/`InstanceType`/`ThisParameterType`.
    // Not one of those wants a binding: they are ordinary type-level functions
    // the checker evaluates as soon as it is given a concrete argument, and the
    // argument is still a type parameter. 378 of that probe's 644 mandatory
    // obligations were this, reported as something else.
    //
    // The reason is interned as the BODY rather than returned as `null` so it
    // reaches `derive.ts` intact; nothing else about a declared name changes.
    if (type.flags & ts.TypeFlags.Conditional) {
      return table.intern({
        kind: 'unresolved',
        fallback: 'erased-type-expression',
        reason: `the conditional type ${conditionalName(type)} is still gated on a type parameter (${declarationLocation.getSourceFile().isDeclarationFile ? 'ambient' : 'source'} declaration); monomorphization never filled it`
      })
    }
    // An enum names a set of literal values, not a structure. Reporting `null`
    // states that honestly; synthesizing an empty object body would claim the
    // declaration has a layout it does not have.
    return null
  }

  return { declaredBodyOf }
}
