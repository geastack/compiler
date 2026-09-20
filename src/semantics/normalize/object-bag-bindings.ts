import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { StructuralShape } from '../model/structural-types.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import { disjointUnionTypeOf, isGlobalObjectConstructor, literalMemberNameOf, widestOf } from './derived-expression-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import type { ValueFlowIndex } from './flow/model.js'
import { definitelyReturns } from './return-paths.js'
import { createBagAbsenceResolver, type BagAbsence } from './bag-absence.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import { isObjectLiteralPrototypeSetter } from './assignment-patterns.js'

/**
 * The members an OPEN PROPERTY BAG carries, inferred from the properties the
 * program actually writes on it.
 *
 * `{}` is the empty object type: zero members, no index signature. So every
 * later `bag.program = p`, `bag.uniforms = u` or `bag[ key ] = value` writes a
 * member the type does not have, the census answers `dynamic`, and a value
 * whose members the program states perfectly well is boxed at every touch.
 * That is the no-boxing rule's own defect: the members are stated, just not in
 * the literal that created the storage.
 *
 * This is the same move `collection-bindings.ts` makes for a bare `new Map()`
 * -- infer the type arguments the program never spelled from the uses it made
 * -- applied to an object literal instead of a collection constructor, and it
 * deliberately mirrors that module's discipline line for line: candidates are
 * recognised syntactically, identity is tracked by DECLARATION rather than by
 * spelling, every observed value for one slot must agree under the one join
 * (`widestOf`), and anything that does not agree refuses the whole bag rather
 * than becoming a source-shaped guess nobody wrote.
 *
 * The shape this exists for is ordinary JavaScript -- a per-object property
 * bag, a keyed cache, a memo table, an options accumulator:
 *
 *     let map = registry.get( object );
 *     if ( map === undefined ) { map = {}; registry.set( object, map ); }
 *     return map;
 *
 * ## What licenses inferring at all
 *
 * - An empty literal supplies no initial fields. A populated data literal is
 *   augmented only when later writes add a missing member; every allocation
 *   field and its initial value participate in the same storage join.
 * - Nothing already states the shape. Three spellings of "already stated" are
 *   tested, because they are three different mechanisms: a contextual type on
 *   the literal (an annotation, a JSDoc `@type`, a typed parameter or return
 *   position), a type node on the owning declaration, and -- the one that is
 *   easy to miss -- TypeScript's OWN expando inference, which in a JavaScript
 *   file types `let output = {}` with the members that `output.geometries =
 *   []` assigns two lines later. That last answer is flow-sensitive within the
 *   function and better than this census can derive; overriding it made two
 *   authorities for one storage whose conversions cannot be satisfied
 *   (MEASURED: 52 unmet obligations on the three.js app, for zero carriers).
 * - The literal is not the operand of an `as`/`satisfies` cast.
 * - Every write to the cell is proved to be the same bag. A cell claimed
 *   from one write and reassigned an untracked value at
 *   another would answer the bag's record at every read while holding
 *   something else: a silent miscompile with a clean certificate.
 * - Identity is by the owner's DECLARATION NODE, the same key
 *   `collection-bindings.ts`'s array census uses and for the same reason: a
 *   property's `ts.Symbol` is late-bound per lookup and is not the same object
 *   at the declaration as at a later `.prop` access, while
 *   `symbol.getDeclarations()?.[0]` is stable across all of them.
 * - Every named member must be WRITTEN somewhere. A key that is only ever read
 *   has no observed value to derive a type from, and inventing one would be
 *   exactly the guess this refuses; the whole bag refuses instead, leaving the
 *   program exactly as it compiles today.
 * - A computed write (`bag[ k ] = v`) licenses the index sidecar half, joined
 *   the same way. A computed READ with no computed write refuses for the same
 *   reason a read-only named key does.
 *
 * ## Aliases
 *
 * A bag usually does not receive its writes under its own name: it is returned
 * from a function and written through an alias. So the bag's identity is
 * propagated to a fixpoint over three purely syntactic, declaration-following
 * edges -- a variable initialized by a bag expression, a function whose
 * `return`s are all bag expressions, and a property assignment that aliases
 * such a function (`return { get: get }`). This is deliberately NOT a general
 * alias analysis and does not try to be: it follows declarations, the same way
 * `collection-bindings.ts` resolves a `.set` call's receiver to the `new Map()`
 * it belongs to, and anything it cannot follow simply never becomes a bag
 * reference.
 *
 * The composed census stack (`frontend.ts`'s `compose`) cannot carry this on
 * its own, and it is worth stating why rather than leaving it to be
 * rediscovered: that composition propagates TYPES, and a bag has no type to
 * propagate until its members are gathered -- which requires knowing, before
 * any type exists, which distant expressions are the same storage. Identity
 * has to be settled first; the composition is what then carries the resulting
 * type outward, which is why this census is given the settled parameter census
 * and asks it at every observed value -- including when resolving a member
 * symbol, since `checker.getSymbolAtLocation` answers nothing for a property
 * of an `any` receiver, which is the state the bags live in.
 *
 * ## What this does NOT reach, and why (measured, do not re-derive)
 *
 * The alias propagation works, and was verified on the largest bag in the
 * corpus: one `{}` whose identity reaches 46 distinct property names written
 * across four files. It still refuses, and the reason is worth recording
 * because it is not a limit of this module:
 *
 * - The program `delete`s two of its NAMED members. A struct field cannot be
 *   removed, so the refusal is correct. Routing a deleted member into the
 *   index sidecar instead would need `emit-properties.ts` to resolve a
 *   CONSTANT key that names no field into the sidecar, which
 *   `preflight/property-access.ts` deliberately refuses to certify today (see
 *   `recordWithIndexFieldText`'s own comment).
 * - More decisively: of that bag's 46 members, about half have a written value
 *   whose OWN type states nothing -- `_gl.createTexture()` and everything
 *   downstream of it. Even with every alias edge and `delete` handled, those
 *   members would derive as `dynamic`, so the boxes would MOVE from the bag
 *   into its own fields rather than disappear. The boxing rooted at that bag
 *   is not caused by the storage being `{}`; it is caused by the values put
 *   into it being untyped, which is a different root with a different fix.
 *
 * So this census's ceiling is set by how well the program types the values it
 * stores, not by how far the identity propagation reaches.
 */

/** The inferred shape of one open property bag. */
export interface ObjectBagShape {
  readonly absences?: readonly BagAbsence[]
  /** Fields present in every allocation and never deleted through a tracked alias. */
  readonly required?: ReadonlySet<string>
  /** Named members, keyed by property name, each the join of every value written to it. */
  readonly members: ReadonlyMap<string, ts.Type>
  /** The value type of the string-keyed index sidecar, or `null` when the bag is never written with a computed key. */
  readonly index: ts.Type | null
}

/**
 * The settled answer to "which declarations name the SAME bag" -- the exact
 * fixpoint the frontend's evidence-policy tables name as this
 * module's one obstacle to a `cells/` evidence policy: no per-node syntactic
 * `candidatesOf` can state "this node is only known to be a candidate once a
 * program-wide closure has converged," so the closure itself has to be
 * published rather than restated.
 *
 * These are the raw maps the fixpoint below already builds (`bagOf`,
 * `returnsBag`, `conflicted`, `ungrounded`), exposed read-only rather than
 * copied or reshaped -- reshaping them would be a second, independently
 * drifting spelling of the one answer this module computes. A consumer that
 * needs a reverse index (every declaration mapped to one root) builds it once
 * from `bagOf`'s entries, the same way this module's own `evidenceOf` is built
 * from `bagRootOf`'s answer, rather than this module guessing which shape a
 * future reader wants.
 */
export interface ObjectBagIdentity {
  /** Every literal owner this fixpoint found, before `conflicted`/`ungrounded` decide which of them may publish a shape -- `literalsByOwner`'s key set. */
  readonly roots: ReadonlySet<ts.Node>
  /** Every declaration proved to hold one bag, mapped to that bag's ROOT declaration (reflexive for a root: `bagOf.get(root) === root`). */
  readonly bagOf: ReadonlyMap<ts.Node, ts.Node>
  /** Every callable whose `return`s all close on one bag, mapped to that bag's root. */
  readonly returnsBag: ReadonlyMap<ts.Node, ts.Node>
  /** Roots that turned out to hold two different bags -- refused wholesale rather than merged. */
  readonly conflicted: ReadonlySet<ts.Node>
  /** Roots whose owning cell also receives a value not proven to be that same root. */
  readonly ungrounded: ReadonlySet<ts.Node>
}

export interface ObjectBagCensus {
  /** The settled bag-identity fixpoint, published for reuse -- see `ObjectBagIdentity`'s own header for why this is the one authority and not a shape a caller re-derives. */
  readonly identity: ObjectBagIdentity
  /** The bag this expression holds -- a tracked `{}` literal, or any reference that resolves to one -- or `null`. */
  readonly shapeAt: (expression: ts.Expression) => ObjectBagShape | null
  /**
   * `shapeAt`'s counterpart keyed by the cell's OWN declaration, for a cell
   * whose bag arrives by a later ASSIGNMENT rather than its initializer.
   *
   * `bagShapeTypeAt` asks a `VariableDeclaration` through its initializer,
   * which is the right question when there is one -- but three's
   * `WebGLProperties.get` writes `let map = properties.get( object ); if ( map
   * === undefined ) { map = {}; ... }`, so the initializer is a CALL (which
   * `shapeAt` deliberately refuses) and the bag is the assignment. This census
   * already claimed that declaration for the bag -- `[BAG] BOUND
   * WebGLProperties.js members=47` -- and nothing could ask for it, so the cell
   * stayed `any`, `get`'s own return stayed `any`, and every
   * `properties.get( material ).uniforms` in `WebGLRenderer.js` and
   * `WebGLMaterials.js` was dynamic behind it.
   *
   * The same owner-keyed shape `collection-bindings.ts` grew for exactly this
   * reason (`arrayElementForOwner`, `typeArgumentsForOwner`): not a second
   * inference, the same one asked at the node a cell's stored carrier is
   * actually published from.
   */
  readonly shapeForOwner: (declaration: ts.Node) => ObjectBagShape | null
  /** The allocation's checker type retains the same shape through type queries and aliases. */
  readonly shapeForType: (type: ts.Type) => ObjectBagShape | null
  /**
   * The bag a CALL returns -- the one question `shapeAt` refuses.
   *
   * `bagRootOf` already resolves it (through `returnsBag`, so the bag's
   * identity propagates across a `return`); `shapeAt` withholds the answer
   * because a call's result has TWO authorities -- the node's own type and the
   * callee's resolved signature -- and moving only one made
   * `producers/invocations.ts` find them disagreeing and WITHHOLD, taking its
   * consumers with it: measured at withheld 8 -> 20, 22 operations silently
   * gone on the three.js app.
   *
   * Withholding is what a producer does when a disagreement has no stated
   * reason. `InvocationResultDivergence` is where a reason is stated, so this
   * is published separately rather than folded into `shapeAt`: a caller that
   * asks it takes on the obligation to declare the divergence
   * (`bag-return-inference`), and every caller that does not keeps the old,
   * safe behaviour untouched.
   */
  readonly callResultShapeAt: (expression: ts.CallExpression | ts.NewExpression) => ObjectBagShape | null
  /** The same returned storage at its callable declaration, where the ABI is published. */
  readonly returnShapeOf: (declaration: ts.Node) => ObjectBagShape | null
  /**
   * The `ts.Type` ONE slot of a tracked bag holds -- `bag.name` or `bag[ k ]`
   * -- widened with `undefined` exactly as `bagShapeTypeAt` widens it.
   *
   * The bag's SHAPE has no `ts.Type` (it becomes a type only through
   * `table.intern`), and that is why this census runs where it does. Its
   * slots are a different question: a member's and an index's observed types
   * are plain `ts.Type`s, so the `ts.Type`-shaped resolvers in
   * `return-bindings.ts` and `local-bindings.ts` CAN consume them, and until
   * this accessor existed they had no way to ask.
   *
   * That gap was load-bearing. Three's `WebGLExtensions` caches every
   * extension in a `{}` and reads it straight back --
   * `if ( extensions[ name ] !== undefined ) return extensions[ name ]` --
   * so the return census refused the function (`return-index-signature-absent`)
   * even though this census had already typed the index from the very next
   * line's `extensions[ name ] = extension`. Everything downstream of
   * `extensions.get( ... )` stayed dynamic behind that one refusal.
   *
   * `null` for an `any` slot: that is the census restating "nothing is known"
   * at field granularity (see `joined`), and handing it back as an answer
   * would turn a caller's honest refusal into a bound `any`.
   */
  readonly slotTypeAt: (expression: ts.Expression) => ts.Type | null
  /**
   * The widening a bag slot's observed type gets -- `T` to `T | undefined`.
   *
   * Exported because BOTH spellings of a slot must be this exact type: the
   * `ts.Type` one `slotTypeAt` hands the write-discovery censuses, and the
   * structural one `bagShapeTypeAt` interns for the record's own field. Two
   * separate constructions of "the same" union is the two-authorities defect
   * in miniature, and it showed up as one the moment `slotTypeAt` existed:
   * a `BufferSourceLike | number` slot came out
   * `tagged-union(undefined|null|present:@ea12f89a)` from one side and
   * `...@2c8ee8eb` from the other, and every read of it wanted a conversion
   * between a carrier and itself.
   *
   * `getNullableType` rather than a hand-built union, because the checker
   * FLATTENS: a slot already holding `T | null` comes back `T | null |
   * undefined` with three arms side by side, never `(T | null) | undefined`
   * with two absence tags stacked -- which `representation/optional.ts`
   * refuses, correctly, and which cost 708 violations on the three.js app when this
   * was spelled by hand.
   */
  readonly slotTypeOf: (type: ts.Type) => ts.Type
  /** How many DISTINCT bags (by owning declaration) this census bound. */
  readonly boundCount: number
  /**
   * Every candidate bag this census could not bind -- root, prose and owner,
   * one `CensusRefusal` per refused root declaration. See `census-refusal.ts`
   * for why this replaced a bare `ReadonlyMap<string, number>`: a count says a
   * cell went untyped, never WHICH one, so nothing downstream could act on a
   * single refusal. A caller that still wants the old shape derives it with
   * `censusRefusalCounts`.
   */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular expression's bag was not bound, or `null` if it was, or if it was never a candidate. */
  readonly refusalOf: (expression: ts.Expression) => string | null
  /** A human-readable dump of every bound bag and refusal, for measurement only -- gated behind an env var at the one call site. */
  readonly debugReport: () => string
}

/** An identity fixpoint that claimed nothing, for callers that state no program. */
const emptyObjectBagIdentity: ObjectBagIdentity = {
  roots: new Set(),
  bagOf: new Map(),
  returnsBag: new Map(),
  conflicted: new Set(),
  ungrounded: new Set()
}

/** A census that binds nothing, for callers that state no program. */
export const emptyObjectBagCensus: ObjectBagCensus = {
  identity: emptyObjectBagIdentity,
  shapeAt: () => null,
  shapeForOwner: () => null,
  shapeForType: () => null,
  callResultShapeAt: () => null,
  returnShapeOf: () => null,
  slotTypeAt: () => null,
  slotTypeOf: (type) => type,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null,
  debugReport: () => ''
}

const isUnusableEvidence = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/** Evidence gathered for one bag before any of it is joined. */
interface BagEvidence {
  readonly namedWrites: Map<string, ts.Expression[]>
  readonly namedReads: Set<string>
  readonly indexWrites: ts.Expression[]
  readonly namedDeletes: Set<string>
  indexDelete: boolean
  /** Set when the bag is read with a computed key -- an index half is then required, not optional. */
  indexRead: boolean
  /** Set when the bag is touched in a way no record layout can state (a spread, a `delete`, a compound assignment). */
  opaqueUse: string | null
}

const emptyEvidence = (): BagEvidence => ({
  namedWrites: new Map(),
  namedReads: new Set(),
  indexWrites: [],
  namedDeletes: new Set(),
  indexDelete: false,
  indexRead: false,
  opaqueUse: null
})

export const censusObjectBagBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  /**
   * The whole-program value-flow index -- see `flow/model.ts`. This census's
   * own identity resolution (`ownerDeclOfExpr`) reads a plain identifier's
   * target from it rather than re-deriving `checker.getSymbolAtLocation`
   * itself, the same edge-source swap `field-bindings.ts`/
   * `collection-bindings.ts` already made. It is NOT a full swap of this
   * census's write discovery -- see this module's own doc comment, "What the
   * shared index cannot express", for why the rest (a property access on a
   * receiver the index cannot name, a call-expression alias root) stays this
   * census's own.
   */
  flow: ValueFlowIndex
): ObjectBagCensus => {
  const declNodeOf = (symbol: ts.Symbol | undefined): ts.Node | null => symbol?.getDeclarations()?.[0] ?? null

  /**
   * The symbol a `receiver.name` access resolves to, asked of the composed
   * census when the checker cannot answer.
   *
   * `checker.getSymbolAtLocation` on a property name returns nothing when the
   * RECEIVER is `any` -- there is no type to look the member up in. That is
   * precisely the state this whole campaign is unwinding, so relying on the
   * checker alone makes the census blind exactly where the bags are: in
   * three's renderer, `properties.get( renderTarget )` resolves inside
   * `WebGLTextures.js` (whose `properties` parameter the parameter census has
   * bound) and NOT inside `WebGLRenderer.js` (whose `properties` local the
   * checker still calls `any`), so the same bag's reads were attributed and
   * its writes were not -- and the bag then refused for a member that is
   * written four lines from where it is read.
   *
   * The fallback is the same `known ?? resolve` rule `observedType` below
   * applies, one level up: ask the census for the receiver's type, then look
   * the member up in it.
   */
  const memberSymbolOf = (access: ts.PropertyAccessExpression): ts.Symbol | undefined => {
    const direct = checker.getSymbolAtLocation(access.name)
    if (direct) return direct
    const own = checker.getTypeAtLocation(access.expression)
    const receiver = isUnusableEvidence(own) ? parameters.typeAt(access.expression) : own
    return receiver?.getProperty(access.name.text)
  }

  /**
   * An EXPANDO member slot's identity: `x.k` where nothing in the program
   * declares `k`.
   *
   * Three's `InterleavedBuffer.clone( data )` takes `@param {Object} [data]`
   * and fills `data.arrayBuffers = {}` two lines before writing keys into it.
   * `{Object}` resolves to the REAL `lib.es5` `Object` interface, which passes
   * every vacuity test and declares no `arrayBuffers` -- so `memberSymbolOf`
   * answers undefined, `ownerDeclOfExpr` answers null, and the bag census
   * never sees a slot that is manifestly a bag. That one slot is the receiver
   * of the keyed write blocking BOTH the `isFogExp2` class-family absence
   * proof and the numeric-absence proof for the WebGL context: ~2042 of
   * the three.js app's carriers, and the program's ONE `typedPropertyBoxes` row
   * (`receiverCarrier: dynamic`, `valueCarrier: record` -- the value was
   * always typed, only the receiver was not).
   *
   * Identity is the member NAME, program-wide, because that is the only
   * over-approximation available: a receiver with no symbol for `k` has no
   * declaration to key on, and `flow/class-family-member-read.ts` already
   * settled on name-keying for exactly this population. Merging unrelated
   * objects that share a name can only make a bag's member set LARGER than
   * the truth, never smaller, and two genuinely different bags landing on one
   * name are refused wholesale by the existing `refused` path rather than
   * merged into a wrong answer.
   *
   * ⚠ The load-bearing guard is `declaredAnywhere`. If ANY access spelling
   * this name resolves to a real symbol, the name is not expando at all and
   * no slot is minted -- because that occurrence would take the ordinary
   * declaration identity while these took the synthetic one, and the same
   * object reached through both spellings would be two bags, each looking
   * closed while the other wrote keys into it. That is a silently SMALLER
   * member set, which is a wrong answer rather than a refusal. A name is
   * therefore either wholly expando or not a bag root at all.
   */
  const expandoSlots = new Map<string, ts.PropertyAccessExpression>()
  let expandoScanned = false
  /**
   * ⚠ Cost, not style: this scan runs over EVERY property access in the
   * program -- ~50k of them once three.js is in the graph -- so it may ask
   * only the cheapest question per node. An earlier version called
   * `memberSymbolOf`, whose fallback reaches `parameters.typeAt` and thus the
   * whole composed parameter census, once per access; the three.js app then produced no
   * output in 200 s. The checker's own `getSymbolAtLocation` is the cheap
   * question and it is asked first for all of them; the expensive one is asked
   * only of the handful of names that survive it.
   */
  const scanExpandoNames = (): void => {
    if (expandoScanned) return
    expandoScanned = true
    const occurrences = new Map<string, ts.PropertyAccessExpression[]>()
    const declaredAnywhere = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text
        if (checker.getSymbolAtLocation(node.name) !== undefined) declaredAnywhere.add(name)
        else {
          const seen = occurrences.get(name)
          if (seen) seen.push(node)
          else occurrences.set(name, [node])
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const file of files) forEachReachableStatement(reachable, file, visit)
    for (const [name, accesses] of occurrences) {
      if (declaredAnywhere.has(name)) continue
      // Every occurrence must have a receiver the checker can type and which
      // genuinely lacks the member. An `any`/`unknown` receiver is NOT
      // evidence of absence -- it is the absence of evidence -- and admitting
      // one would let a declared member elsewhere take the ordinary identity
      // while this took the synthetic one, splitting one object into two bags.
      const expando = accesses.every((access) => {
        const receiver = checker.getTypeAtLocation(access.expression)
        return !isUnusableEvidence(receiver) && receiver.getProperty(name) === undefined
      })
      if (expando) expandoSlots.set(name, accesses[0]!)
    }
    if (process.env['GEA_EXPANDO_BAG_DEBUG'])
      for (const [name, node] of expandoSlots)
        console.error(
          `[EXPANDO-BAG] ${name} ${node.getSourceFile().fileName.split('/').slice(-1)[0]} occurrences=${occurrences.get(name)?.length}`
        )
  }

  /** The interned slot node for `x.k`, or null when `k` is declared somewhere. */
  const expandoOwnerOf = (expression: ts.Expression): ts.Node | null => {
    if (!ts.isPropertyAccessExpression(expression)) return null
    scanExpandoNames()
    return expandoSlots.get(expression.name.text) ?? null
  }

  /**
   * The declaration node backing a plain identifier or `x.prop` -- this
   * census's one identity key.
   *
   * The identifier half is now the shared `flow.targetOf` -- the identical
   * `checker.getSymbolAtLocation` + first-declaration computation this
   * function used to make privately, sourced from the one walk every census
   * now reads (see `flow/targets.ts`'s `flowTargetOf`). Measured
   * byte-identical on the three.js app (see `NOTES.md`), which is the expected
   * signature of a faithful edge-source swap, not a coincidence: an
   * identifier's target is a pure symbol lookup with no receiver-type
   * fallback to diverge over.
   *
   * The property-access half stays this census's own `memberSymbolOf`,
   * deliberately not routed through `flow.targetOf`: that shared resolver has
   * no receiver-type fallback (it answers `null` the instant
   * `checker.getSymbolAtLocation` fails at both the access and its `.name`),
   * while `memberSymbolOf`'s whole reason to exist is answering exactly that
   * case from the composed parameter census -- `properties.get(renderTarget)`
   * resolving where the checker alone cannot, because the receiver is `any`.
   * Preferring the shared resolver's OWN whole-access fallback ahead of that
   * one would silently pick a different (checker-only) answer over this
   * census's richer one for no gain; deferring to `memberSymbolOf` unchanged
   * keeps the fallback this file was written to have.
   */
  const ownerDeclOfExpr = (expression: ts.Expression): ts.Node | null => {
    if (ts.isIdentifier(expression)) return flow.targetOf(expression)?.declaration ?? null
    // The expando slot is consulted only AFTER both the checker and the
    // composed census decline: a slot that has a declaration keeps it, so
    // this adds an identity where there was none rather than replacing one.
    if (ts.isPropertyAccessExpression(expression)) return declNodeOf(memberSymbolOf(expression)) ?? expandoOwnerOf(expression)
    return null
  }

  /** The checker's own answer, falling back to the composed parameter census -- the same `known ?? resolve` rule every census here applies. */
  const observedType = (expression: ts.Expression): ts.Type | null => {
    const own = checker.getTypeAtLocation(expression)
    return isUnusableEvidence(own) ? parameters.typeAt(expression) : own
  }

  /**
   * Whether a type says anything this census would be overriding.
   *
   * `any`/`unknown`/`void`/`never` state nothing by construction. So does the
   * EMPTY object type: `{}` in a contextual position, and `{}` observed as a
   * written value, are the same non-statement -- zero members, zero index
   * signatures, zero call signatures. Treating either as a stated answer is
   * what silently excluded the exact shape this module exists for, because the
   * contextual type of `map = {}`'s right-hand side is the left-hand side's
   * own (`any`) type. And admitting one as evidence is how a bound bag ends up
   * with a member whose carrier is an empty record -- a struct with no fields,
   * which is not an improvement on a box, it is a different way to say
   * nothing.
   *
   * `never[]` is the third spelling of the same non-statement: an empty array
   * literal with no contextual type, which is TypeScript declining to guess
   * rather than a fact about the program (`collection-bindings.ts`'s array
   * census exists for exactly that reading).
   *
   * TRIED AND REVERTED: a bare JSDoc `@type {Object}` (or an un-dotted
   * `@type {Object<K,V>}`, which TS's JSDoc parser does not treat as an
   * index-signature shorthand) is a fourth spelling of the same
   * non-statement, and `derived-expression-type.ts` already exports
   * `annotationStatesNothing` for exactly this reading elsewhere in the
   * compiler. OR-ing it into this check DOES widen candidacy exactly as
   * expected -- three's `this.morphAttributes = {}` (`BufferGeometry`,
   * annotated `@type {Object}`) and two `ShaderMaterial.js` uniform bags
   * newly BIND -- but MEASURED on the three.js app this is a pure regression: boxed
   * and ops stay byte-identical (725->773 `missing`, +48, 0 removed,
   * confirmed via a before/after preflight-obligation-id diff) with zero
   * compensating reduction anywhere. Root cause traced past this file: the
   * newly-bound `morphAttributes` shape selects `record-with-index` (it has
   * both named members AND a computed-key write,
   * `geometry2.morphAttributes[ name ] = morphArray` in `.copy()`) where the
   * SAME literal, unbound, was already resolving to a plain `record` via a
   * different, existing authority -- and the C++ backend has no
   * `value:allocation:object-literal:record-with-index` runtime helper for
   * that combination (an array-typed member/index) yet, so the more precise
   * answer this module now gives is correct but unimplementable downstream.
   * That is a real, separate emitter gap (`targets/cpp/`), not something
   * this file's identity tracking can fix, and out of this module's own
   * scope -- landing the wider candidacy check without it trades a working
   * plain-record path for a preflight failure, for zero app-visible
   * gain. Left OUT. Whoever wires that runtime helper should revisit this.
   */
  const statesNothing = (type: ts.Type): boolean => {
    if (isUnusableEvidence(type)) return true
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference)
      return element !== undefined && (element.flags & ts.TypeFlags.Never) !== 0
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return false
    return (
      type.getProperties().length === 0 &&
      checker.getIndexInfosOfType(type).length === 0 &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0
    )
  }

  /**
   * A declaration that states its own type states this census's answer too --
   * there is nothing to add.
   *
   * Two spellings, and the second is the load-bearing one. An explicit type
   * node is the obvious case. The other is the checker's own expando
   * inference: in a JavaScript file `let output = {}` followed by
   * `output.geometries = []` in the same scope is typed WITH those members by
   * TypeScript itself, flow-sensitively, which is a better answer than this
   * census can derive and is left alone for the same reason
   * `collection-bindings.ts` leaves `settleEvolving`'s empty arrays alone. The
   * literal itself is no help in telling the two apart -- `{}` is the empty
   * object type at its own node either way -- so the question is asked of the
   * declaration, which is where the inferred members actually land.
   */
  const declaresOwnType = (declaration: ts.Node): boolean => {
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)) {
      if (declaration.type !== undefined) return true
    }
    const symbol = checker.getSymbolAtLocation(
      ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)
        ? declaration.name
        : declaration
    )
    if (!symbol) return false
    return !statesNothing(checker.getTypeOfSymbolAtLocation(symbol, declaration))
  }

  const declaresWrittenType = (owner: ts.Node): boolean =>
    ((ts.isVariableDeclaration(owner) || ts.isPropertyDeclaration(owner) || ts.isParameter(owner) || ts.isFunctionLike(owner)) &&
      owner.type !== undefined) ||
    ts.getJSDocType(owner) !== undefined ||
    (ts.isFunctionLike(owner) && ts.getJSDocReturnType(owner) !== undefined) ||
    (ts.isParameter(owner) && ts.getJSDocParameterTags(owner).some((tag) => tag.typeExpression !== undefined))

  /**
   * A `{}` the program has not already typed for itself, not cast, not spread
   * into anything.
   *
   * Both halves of "already typed" are tested, and the second is the one that
   * is easy to miss: in a JavaScript file the checker performs its OWN expando
   * inference, synthesizing members onto `let output = {}` from the
   * `output.geometries = []` assignments that follow it in the same scope. That
   * answer is flow-sensitive within the function and is BETTER than anything
   * this census could derive -- exactly the relationship
   * `collection-bindings.ts` has with `settleEvolving` for an empty array
   * literal, and it is left alone for the same reason. Overriding it does not
   * merely duplicate work: it makes two authorities for one storage, and the
   * conversions between them are unsatisfiable. MEASURED on the three.js app: admitting
   * the expando-typed literals costs 52 unmet `native-record-ref(...) ->
   * record(...)` obligations -- the checker's answer on one side of the arrow
   * and this census's on the other -- for zero additional carriers.
   */
  const isBareEmptyLiteral = (node: ts.Node): node is ts.ObjectLiteralExpression => {
    if (!ts.isObjectLiteralExpression(node) || node.properties.length > 0) return false
    const parent = node.parent
    if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) return false
    const contextual = checker.getContextualType(node)
    if (contextual !== undefined && !statesNothing(contextual)) return false
    return statesNothing(checker.getTypeAtLocation(node))
  }

  // Seed an inferred record with its actual allocation writes. A populated
  // literal is only published below when later writes add a missing member;
  // otherwise its existing checker shape remains the authority.
  const initialMembersOf = (node: ts.Node): ReadonlyMap<string, ts.Expression> | null => {
    if (!ts.isObjectLiteralExpression(node) || node.properties.length === 0) return null
    if (ts.isAsExpression(node.parent) || ts.isSatisfiesExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)) return null
    if (checker.getContextualType(node) !== undefined) return null
    const fields = new Map<string, ts.Expression>()
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name)) return null
      if (isObjectLiteralPrototypeSetter(property)) return null
      fields.set(property.name.text, ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
    }
    return fields
  }

  // Allocation ownership and replacement checks consume the same whole-cell
  // inventory. A field initializer is an ordinary bind here, so it cannot be
  // admitted as a root while its later replacements are invisible to the proof.
  // Frame/return edges transport values but do not give an inline allocation a
  // stable storage owner; their aliases are handled by the existing closure.
  const storageWrites = flow.allWrites.filter((write) => write.slot === 'whole')
  const ownerOfWrite = (write: (typeof storageWrites)[number]): ts.Node | null =>
    (write.naming && ts.isPropertyAccessExpression(write.naming) ? ownerDeclOfExpr(write.naming) : null) ?? write.target.declaration
  const allocationOwners = new Map<ts.Expression, ts.Node | null>()
  for (const write of storageWrites) {
    if (
      write.value === null ||
      !['declaration-initializer', 'class-field-initializer', 'identifier-assignment', 'property-assignment', 'index-assignment'].includes(
        write.edge
      )
    )
      continue
    const owner = ownerOfWrite(write)
    if (!owner) continue
    const existing = allocationOwners.get(write.value)
    allocationOwners.set(write.value, existing === undefined || existing === owner ? owner : null)
  }
  const literalOwnerOf = (node: ts.ObjectLiteralExpression, populated = false): ts.Node | null => {
    const owner = allocationOwners.get(node)
    return owner && !(populated ? declaresWrittenType : declaresOwnType)(owner) ? owner : null
  }

  // Pass 1: every candidate `{}`, grouped by the declaration it fills.
  const literalsByOwner = new Map<ts.Node, ts.ObjectLiteralExpression[]>()
  const literalOwner = new Map<ts.ObjectLiteralExpression, ts.Node>()
  const initialMembers = new Map<ts.ObjectLiteralExpression, ReadonlyMap<string, ts.Expression>>()
  const collectLiterals = (node: ts.Node): void => {
    const initial = initialMembersOf(node)
    if (isBareEmptyLiteral(node) || (ts.isObjectLiteralExpression(node) && initial !== null)) {
      const owner = literalOwnerOf(node, initial !== null)
      if (owner) {
        if (initial !== null) initialMembers.set(node, initial)
        literalOwner.set(node, owner)
        const existing = literalsByOwner.get(owner)
        if (existing) existing.push(node)
        else literalsByOwner.set(owner, [node])
      }
    }
    ts.forEachChild(node, collectLiterals)
  }
  for (const file of files) forEachReachableStatement(reachable, file, collectLiterals)

  // Pass 2: propagate bag identity outward along declaration-following edges,
  // to a fixpoint. `bagOf` maps a declaration to the ROOT bag owner it holds;
  // `returnsBag` maps a function declaration to the root bag it returns.
  const bagOf = new Map<ts.Node, ts.Node>()
  for (const owner of literalsByOwner.keys()) bagOf.set(owner, owner)
  const returnsBag = new Map<ts.Node, ts.Node>()
  /** Declarations that turned out to hold two different bags -- refused wholesale rather than merged. */
  const conflicted = new Set<ts.Node>()
  /** Candidate roots whose owning cell also receives a value not proved to be that root. */
  const ungrounded = new Set<ts.Node>()

  const claim = (declaration: ts.Node, root: ts.Node): boolean => {
    const existing = bagOf.get(declaration)
    if (existing === root) return false
    if (existing !== undefined) {
      conflicted.add(existing)
      conflicted.add(root)
      return false
    }
    bagOf.set(declaration, root)
    return true
  }

  /**
   * Whether every write to a cell is PROVED to carry one bag root.
   *
   * This is deliberately an identity-only question. The old rule admitted a
   * write when its current type was `any`/`unknown`/empty and revoked that
   * admission once an outer census learned a concrete type. That made absence
   * of evidence positive alias evidence, so the composed census was
   * anti-monotone: Fastify's `let constraints = {}; constraints =
   * opts.constraints` alternated forever between publishing the empty bag and
   * withdrawing it as `opts.constraints` became known.
   *
   * A direct value-flow chain can only add a root to `bagOf`; it never loses
   * one. A write not yet rooted is therefore pending, not permission. This is
   * the must-alias lattice the public type census needs: one proven root may be
   * published, two roots conflict, and an ungrounded write publishes nothing.
   * Types still classify the VALUES stored in a proven bag's slots below, but
   * they never decide whether two references are the same storage.
   */
  const admissibleWrites = (declaration: ts.Node, root: ts.Node): boolean => {
    if (unknownWrites.has(declaration)) return false
    const writes = writesTo.get(declaration)
    if (!writes) return true
    return writes.every((value) => bagRootOf(value) === root)
  }

  /**
   * The function a callee expression names, unwrapping one `k: fn`
   * property-assignment alias -- OR, the same unwrap one syntax shape over,
   * a `k: function( ... ) { ... }` property whose value IS the callable
   * directly rather than a reference to one declared elsewhere. Three's
   * `ColorManagement.define: function( colorSpaces ) {...}` is exactly this
   * shape: nothing ever names `define` as an identifier, so the existing
   * `ts.isIdentifier(declaration.initializer)` arm never fires, and every
   * call `ColorManagement.define( x )` used to resolve no further than the
   * `PropertyAssignment` itself -- not a `FunctionDeclaration`/
   * `FunctionExpression`/`ArrowFunction`/`MethodDeclaration`, so neither the
   * `returnsBag` edge nor the call-argument-to-parameter edge below ever
   * saw it, and `define`'s own parameter never got claimed even though its
   * ONLY reads are inside `define`'s own body. Reusing the initializer
   * itself as the callee is not a new alias rule -- it is what
   * `ownerDeclOfExpr` would have named directly had the call spelled the
   * function out where it is written (`(function( colorSpaces ){...})( x )`)
   * instead of through the one property that owns it.
   */
  const calleeDeclarationOf = (callee: ts.Expression): ts.Node | null => {
    const declaration = ownerDeclOfExpr(callee)
    if (!declaration) return null
    if (ts.isPropertyAssignment(declaration)) {
      if (ts.isIdentifier(declaration.initializer)) return declNodeOf(checker.getSymbolAtLocation(declaration.initializer))
      if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) return declaration.initializer
    }
    return declaration
  }

  /** The root bag this expression evaluates to, or `null`. */
  const bagRootOf = (expression: ts.Expression): ts.Node | null => {
    if (ts.isObjectLiteralExpression(expression)) {
      const owner = literalOwner.get(expression)
      return owner ? (bagOf.get(owner) ?? null) : null
    }
    // `new F()` is the same question as `F()` here. JS's `[[Construct]]`
    // returns the object a constructor-invoked function RETURNS, discarding
    // the fresh `this` -- so a factory that ends `return theBag` evaluates to
    // that bag under `new` just as it does under a call, and reading only
    // `CallExpression` made this census answer two spellings of one fact
    // differently.
    //
    // The one case `new` differs is a path that returns nothing: `[[Construct]]`
    // then yields the fresh `this` rather than the bag. That is the same
    // fall-through exposure the call arm already carries (a call returning
    // `undefined` on one path), and `returnsBag` bounds both the same way --
    // every `return` in the body must name the same bag, or nothing is claimed.
    //
    // A returned inline literal has no storage owner. A populated literal
    // bound to a declaration can participate when later member writes extend
    // it, under the same identity proof as an initially empty bag.
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      const callee = calleeDeclarationOf(expression.expression)
      return callee ? (returnsBag.get(callee) ?? null) : null
    }
    const declaration = ownerDeclOfExpr(expression)
    return declaration ? (bagOf.get(declaration) ?? null) : null
  }

  // The `return` expressions of every function body, and the declarations
  // initialized/assigned from an expression -- both collected once, then
  // replayed until nothing new is claimed.
  const returnsOf = new Map<ts.Node, (ts.Expression | null)[]>()
  const assignments: { readonly target: ts.Node; readonly value: ts.Expression }[] = []
  /** Every write to one declaration, so a claim can be tested against ALL of them and not just the one that made it. */
  const writesTo = new Map<ts.Node, ts.Expression[]>()
  const unknownWrites = new Set<ts.Node>()
  const noteWrite = (target: ts.Node, value: ts.Expression): void => {
    const existing = writesTo.get(target)
    if (existing?.includes(value)) return
    assignments.push({ target, value })
    if (existing) existing.push(value)
    else writesTo.set(target, [value])
  }
  for (const write of storageWrites) {
    if (write.edge === 'return' || write.edge === 'yield') continue
    const owner = ownerOfWrite(write)
    if (!owner) continue
    if (write.value === null) unknownWrites.add(owner)
    else noteWrite(owner, write.value)
  }
  const collectEdges = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      const owner = ts.findAncestor(
        node,
        (candidate) =>
          ts.isFunctionDeclaration(candidate) ||
          ts.isFunctionExpression(candidate) ||
          ts.isArrowFunction(candidate) ||
          ts.isMethodDeclaration(candidate)
      )
      if (owner) {
        const existing = returnsOf.get(owner)
        if (existing) existing.push(node.expression ?? null)
        else returnsOf.set(owner, [node.expression ?? null])
      }
    }
    // A bag passed AS AN ARGUMENT is the same storage inside the callee: the
    // callee's parameter is one more declaration holding it, claimed exactly
    // the way a variable initialized from it is. Only an unannotated
    // parameter of a callee resolved by declaration -- the same resolution a
    // return already uses -- and only positionally: a rest parameter or a
    // spread argument is no single slot and claims nothing.
    // `new F( a, b )` binds F's parameters exactly as `F( a, b )` does -- the
    // construct semantics differ only in what the EXPRESSION evaluates to, never
    // in how arguments reach the frame. Excluding it had nothing to do with
    // construction and everything to do with the node kind not being listed.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeDeclarationOf(node.expression)
      if (
        callee &&
        (ts.isFunctionDeclaration(callee) ||
          ts.isFunctionExpression(callee) ||
          ts.isArrowFunction(callee) ||
          ts.isMethodDeclaration(callee))
      ) {
        ;(node.arguments ?? []).forEach((argument, position) => {
          if (ts.isSpreadElement(argument)) return
          const parameter = callee.parameters[position]
          if (!parameter || parameter.dotDotDotToken || parameter.type || !ts.isIdentifier(parameter.name)) return
          noteWrite(parameter, argument)
        })
      }
    }
    ts.forEachChild(node, collectEdges)
  }
  for (const file of files) forEachReachableStatement(reachable, file, collectEdges)

  // Finite ascending worklist: `bagOf` and `returnsBag` only gain entries, so
  // this terminates after at most one successful claim per declaration/return
  // cell. A numeric round cap would merely hide an incomplete identity graph.
  while (true) {
    let grew = false
    for (const { target, value } of assignments) {
      const root = bagRootOf(value)
      if (root && admissibleWrites(target, root) && claim(target, root)) grew = true
    }
    for (const [owner, expressions] of returnsOf) {
      if (!(
        ts.isFunctionDeclaration(owner) ||
        ts.isFunctionExpression(owner) ||
        ts.isArrowFunction(owner) ||
        ts.isMethodDeclaration(owner)
      ))
        continue
      // A returned bag is not a promise/iterator or an optional result. Reuse
      // the return census's exit proof and keep every bare return in the join.
      if (!owner.body || !ts.isBlock(owner.body) || !definitelyReturns(owner.body.statements)) continue
      if ((ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async) !== 0 || ('asteriskToken' in owner && owner.asteriskToken)) continue
      const roots = expressions.map((expression) => (expression ? bagRootOf(expression) : null))
      const [first] = roots
      // Every `return` must be the same bag: a function returning a bag on one
      // path and something else on another has no single storage to name.
      if (!first || roots.some((root) => root !== first)) continue
      const existing = returnsBag.get(owner)
      if (existing === first) continue
      if (existing) {
        conflicted.add(existing)
        conflicted.add(first)
        continue
      }
      returnsBag.set(owner, first)
      grew = true
    }
    if (!grew) break
  }

  // Root owners are cells too. Seeding their allocation site above is needed
  // to ground alias cycles, but it is not permission to ignore a competing
  // write to the owner itself. Validate them by the same must-alias rule before
  // any shape is published.
  for (const root of literalsByOwner.keys()) if (!admissibleWrites(root, root)) ungrounded.add(root)

  // Pass 3: every property touch whose receiver resolves to a tracked bag.
  const evidenceOf = new Map<ts.Node, BagEvidence>()
  const evidenceFor = (root: ts.Node): BagEvidence => {
    const existing = evidenceOf.get(root)
    if (existing) return existing
    const fresh = emptyEvidence()
    evidenceOf.set(root, fresh)
    return fresh
  }

  const isWriteTarget = (access: ts.Expression): ts.Expression | null => {
    const parent = access.parent
    if (!ts.isBinaryExpression(parent) || parent.left !== access) return null
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? parent.right : null
  }

  const isCompoundTarget = (access: ts.Expression): boolean => {
    const parent = access.parent
    if (ts.isBinaryExpression(parent) && parent.left === access) return parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    if (ts.isPostfixUnaryExpression(parent)) return parent.operand === access
    return ts.isPrefixUnaryExpression(parent) && parent.operand === access
  }

  /**
   * `Object.assign( bag, source )` -- the one BULK write this census
   * recognises, alongside the per-property `bag.x = v` / `bag[ k ] = v`
   * writes `collectUses` already reads. Three's `ColorManagement.spaces` is
   * the motivating case: every touch of it is `this.spaces[ colorSpace ]`
   * (a computed read), and the ONLY write anywhere is
   * `Object.assign( this.spaces, colorSpaces )` inside `define()` -- so
   * without this, the bag's identity resolves (it is BOUND-able) but it
   * refuses `bag:no-writes` for a write the program plainly makes, just not
   * spelled as an assignment.
   *
   * The source is usually not the literal itself but a PARAMETER that
   * merely forwards one -- three's actual call is
   * `ColorManagement.define({ [ LinearSRGBColorSpace ]: {...}, ... })`,
   * where `define`'s body reads `Object.assign( this.spaces, colorSpaces )`
   * one frame removed from the literal. So this reads two shapes, in order:
   * an INLINE literal's own syntax first, and otherwise the TYPE the
   * checker (or, when that states nothing, the settled parameter census --
   * `observedType`, the same `known ?? resolve` rule every reader in this
   * module applies) gives the source expression, whose properties are
   * exactly the ones the census's own composition already bound from the
   * call site -- not a second guess, the SAME evidence the syntactic path
   * would read, one indirection later. A property with a plain name is a
   * named write, one with a computed name is index evidence -- literally
   * the same partition `collectUses` already makes between a
   * `PropertyAccessExpression` and an `ElementAccessExpression` write.
   *
   * A source whose shape cannot be read either way states no keys this
   * census can attribute without guessing which ones moved, so it is
   * `opaqueUse`, the same refusal a spread already gets -- proportional
   * degradation stops at "one slot degrades to `any`" (see `joined`)
   * because that answer needs a KNOWN key; a whole unknown key set has no
   * slot to degrade.
   *
   * The callee is checked on its own TYPE's declaration IDENTITY --
   * `isGlobalObjectConstructor` (`derived-expression-type.ts`), the shared
   * authority that idiom now goes through, so a local binding that merely
   * happens to be named `Object` is never mistaken for the global. This used
   * to be a second, independently written copy of `flow/value-flow.ts`'s own
   * `isGlobalObjectAssign` -- byte-for-byte identical logic asking the same
   * question twice; both now call the one shared function.
   */
  const isGlobalObjectAssignCall = (node: ts.CallExpression): boolean => {
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'assign') return false
    if (!ts.isIdentifier(callee.expression)) return false
    return isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression))
  }

  interface MergedProperties {
    readonly named: ReadonlyMap<string, ts.Expression>
    readonly index: readonly ts.Expression[]
  }

  /** A merge source's own literal syntax, when it IS the literal. */
  const mergedPropertiesFromLiteral = (source: ts.ObjectLiteralExpression): MergedProperties | null => {
    const named = new Map<string, ts.Expression>()
    const index: ts.Expression[] = []
    for (const property of source.properties) {
      if (!ts.isPropertyAssignment(property)) return null
      if (ts.isComputedPropertyName(property.name)) {
        index.push(property.initializer)
        continue
      }
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name)) return null
      named.set(property.name.text, property.initializer)
    }
    return { named, index }
  }

  /**
   * The same shape read off a RESOLVED TYPE instead of syntax, for a merge
   * source that is itself an alias (see this function's own doc) whose
   * type genuinely lists named members. Only NAMED members are read this
   * way: a property symbol's declaration is the `PropertyAssignment` the
   * literal actually wrote, at whichever call site the parameter census
   * resolved -- an index signature has no single declaration to cite one
   * write expression from, so it is left for a `bag[ k ] = v` write or an
   * inline/forwarded literal source (`mergedPropertiesOf`'s other arm) to
   * state instead.
   */
  const mergedPropertiesFromType = (source: ts.Expression): MergedProperties | null => {
    const type = observedType(source)
    if (!type || statesNothing(type)) return null
    const named = new Map<string, ts.Expression>()
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      if (!declaration || !ts.isPropertyAssignment(declaration) || ts.isComputedPropertyName(declaration.name)) return null
      named.set(property.name, declaration.initializer)
    }
    return { named, index: [] }
  }

  /**
   * The merge source's shape, tried three ways in order: its own syntax
   * when it IS the literal; failing that, the ONE literal expression this
   * module's own write-set already recorded for it (`writesTo`, the same
   * table the call-argument edge above fills for `define( colorSpaces )` --
   * `colorSpaces` is not itself a bag, so `bagRootOf` never claims it, but
   * it is still exactly one parameter written from exactly one place, and
   * that place IS the literal -- reading it back out is not a second
   * alias rule, it is the SAME edge `admissibleWrites` already reads for a
   * bag value, asked of a non-bag one); and only then the resolved TYPE,
   * for a source this module cannot trace to a single write at all.
   */
  const mergedPropertiesOf = (source: ts.Expression): MergedProperties | null => {
    if (ts.isObjectLiteralExpression(source)) return mergedPropertiesFromLiteral(source)
    const owner = ownerDeclOfExpr(source)
    const writes = owner ? writesTo.get(owner) : undefined
    if (writes && writes.length === 1 && owner && !unknownWrites.has(owner)) {
      const [only] = writes
      if (only && ts.isObjectLiteralExpression(only)) return mergedPropertiesFromLiteral(only)
    }
    return mergedPropertiesFromType(source)
  }

  const collectObjectAssign = (node: ts.CallExpression): void => {
    const target = node.arguments[0]
    if (target === undefined || node.arguments.length < 2 || !isGlobalObjectAssignCall(node)) return
    const root = bagRootOf(target)
    if (!root) return
    const evidence = evidenceFor(root)
    for (const source of node.arguments.slice(1)) {
      const merged = ts.isSpreadElement(source) ? null : mergedPropertiesOf(source)
      if (!merged) {
        evidence.opaqueUse = 'Object.assign'
        continue
      }
      for (const [key, value] of merged.named) {
        const existing = evidence.namedWrites.get(key)
        if (existing) existing.push(value)
        else evidence.namedWrites.set(key, [value])
      }
      evidence.indexWrites.push(...merged.index)
    }
  }

  const collectUses = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) collectObjectAssign(node)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = bagRootOf(node.expression)
      if (root) {
        const evidence = evidenceFor(root)
        // A compound assignment (`bag.n += 1`, `bag.n ++`) is a READ, not a
        // write this census can type: its value expression is the slot's own
        // previous contents, which is what is being inferred. So it states
        // that the member EXISTS and nothing about what it holds -- exactly
        // what a plain read states. If some other site writes the member
        // outright, that write types it; if none does, `member-never-written`
        // refuses the bag, which is the same answer by the same rule rather
        // than a second one.
        const written = isCompoundTarget(node) ? null : isWriteTarget(node)
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : literalMemberNameOf(node)
        if (key !== null) {
          if (written) {
            const existing = evidence.namedWrites.get(key)
            if (existing) existing.push(written)
            else evidence.namedWrites.set(key, [written])
          } else evidence.namedReads.add(key)
        } else if (written) evidence.indexWrites.push(written)
        else evidence.indexRead = true
      }
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      const root = bagRootOf(node.expression)
      if (root) evidenceFor(root).opaqueUse = 'spread'
    }
    if (ts.isDeleteExpression(node)) {
      const target = node.expression
      // `delete bag[k]` is ordinary dictionary behaviour -- the `dictionary`
      // carrier's own `std::map` erase (`emit-dynamic-properties.ts`) -- so it
      // is index evidence, adding no type of its own. `delete bag.x` is a
      // transition every member of a bag already admits: the members are all
      // OPTIONAL (a bag starts empty), so "removed" is a state inside the
      // member's stated domain, and the delete contributes no type either --
      // only the fact that the member exists, recorded the way a read records
      // it, so a member that is ONLY ever deleted still refuses as
      // never-written. Whether the backend can lower the delete itself is the
      // backend's own, separately-gated question; if it cannot, that one site
      // fails closed by name instead of this census refusing the whole bag
      // for a state its members already carry.
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const root = bagRootOf(target.expression)
        if (root) {
          const evidence = evidenceFor(root)
          const key = ts.isPropertyAccessExpression(target) ? target.name.text : literalMemberNameOf(target)
          if (key === null) {
            evidence.indexRead = true
            evidence.indexDelete = true
          } else {
            evidence.namedReads.add(key)
            evidence.namedDeletes.add(key)
          }
        }
      }
    }
    ts.forEachChild(node, collectUses)
  }
  for (const file of files) forEachReachableStatement(reachable, file, collectUses)

  /**
   * The one type covering every value written to a slot.
   *
   * A write whose own type states nothing (`any`, an empty object, `never[]`)
   * degrades THAT SLOT to the checker's own `any` -- the member field derives
   * `dynamic`, exactly the carrier every touch of it has today -- rather than
   * refusing the whole bag. This is not a guess: `any` is precisely what the
   * program states for that value, restated at field granularity. What it
   * buys is proportionality: one untyped write no longer forces every OTHER
   * member, and every read of the bag itself, back into the box. Genuine
   * DISAGREEMENT between typed writes still refuses -- `any` never absorbs a
   * conflict this census can see, only a statement the program never made.
   */
  const joined = (expressions: readonly ts.Expression[]): ts.Type | 'disagree' | 'states-nothing' => {
    const types: ts.Type[] = []
    for (const expression of expressions) {
      const type = observedType(expression)
      if (!type || statesNothing(type)) return 'states-nothing'
      types.push(type)
    }
    // When no one write covers the others, the disagreement can still be the
    // answer: three's renderer writes `materialProperties.lightProbeGrid` as a
    // boolean at program acquisition and as a grid-or-null per object, and the
    // slot holds exactly that union. Degrading it to `any` sent every read of
    // it -- and the narrowing that follows -- to the box for a value whose
    // every write was typed. The same second question the array census asks
    // (`collection-bindings.ts`), answered by the same rule, so a set that
    // census would refuse (a member subsuming another, too many arms) is
    // refused here too.
    const widest = widestOf(checker, types) ?? disjointUnionTypeOf(checker, types)
    return widest ?? 'disagree'
  }

  /** See `ObjectBagCensus.slotTypeOf` -- the ONE widening, shared by both spellings of a slot. */
  const widenSlot = (type: ts.Type): ts.Type =>
    (type.flags & ts.TypeFlags.Any) !== 0 ? type : checker.getNullableType(type, ts.TypeFlags.Undefined)

  const bound = new Map<ts.Node, ObjectBagShape>()
  const refusalReason = new Map<ts.Node, string>()
  // Why each slot that came out `any` did, keyed `<bag>.<member>`. A bound bag
  // reporting `any=18` says nothing about whether there is work behind those
  // slots: a slot degraded because its one write states nothing is a cascade,
  // while one degraded because its writes DISAGREE or carry `null` is a
  // decision this census made and could make differently. Measurement only --
  // read by `debugReport`, which is itself behind an env var.
  const memberReason = new Map<string, string>()
  const identityOf = (node: ts.Node): string => {
    const file = node.getSourceFile()
    return `${file.fileName.split('/').slice(-1)[0]}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  }

  // `censusRefusals` is the published list (`census-refusal.ts`); `refusalReason`
  // stays as the internal by-root lookup `refusalOf`/`debugReport` already key
  // on, so this one call sites both without a second, independently-drifting
  // reason string. The owner is the root's own declaration -- `identityOf`,
  // the same file:line this module already prints in `debugReport` -- because
  // a whole-bag refusal is never about a slot, only about the storage itself.
  const censusRefusals: CensusRefusal[] = []
  const refuseRoot = (root: ts.Node, censusRoot: string, reason: string): void => {
    refusalReason.set(root, reason)
    censusRefusals.push(censusRefusal('bag', censusRoot, reason, identityOf(root)))
  }

  for (const root of literalsByOwner.keys()) {
    if (conflicted.has(root)) {
      refuseRoot(root, 'two-bags-one-cell', 'bag:two-bags-one-cell')
      continue
    }
    if (ungrounded.has(root)) {
      refuseRoot(root, 'write-not-proven-alias', 'bag:write-not-proven-alias')
      continue
    }
    const evidence = evidenceOf.get(root)
    const literals = literalsByOwner.get(root) ?? []
    const populated = literals.some((literal) => initialMembers.has(literal))
    const initialKeys = new Set(literals.flatMap((literal) => [...(initialMembers.get(literal)?.keys() ?? [])]))
    if (populated && (!evidence || ![...evidence.namedWrites.keys()].some((key) => !initialKeys.has(key)))) continue
    if (!evidence) {
      refuseRoot(root, 'no-uses', 'bag:no-uses')
      continue
    }
    if (evidence.opaqueUse) {
      // `opaqueUse` only ever holds one of two literal causes (`collectUses`,
      // `collectObjectAssign`), so each is its own stable root rather than one
      // root fed by an interpolated, in-principle-unbounded string.
      refuseRoot(root, evidence.opaqueUse === 'spread' ? 'opaque-spread' : 'opaque-object-assign', `bag:${evidence.opaqueUse}`)
      continue
    }
    // Allocation fields and later assignments fill the same slots. Keep
    // insertion order from the literal and include every initial value in
    // the join, so augmentation cannot erase a field or narrow its writes.
    const writes = new Map<string, ts.Expression[]>()
    for (const literal of literals)
      for (const [key, value] of initialMembers.get(literal) ?? []) {
        const values = writes.get(key) ?? []
        values.push(value)
        writes.set(key, values)
      }
    for (const [key, values] of evidence.namedWrites) writes.set(key, [...(writes.get(key) ?? []), ...values])
    const required = new Set(
      [...initialKeys].filter(
        (key) =>
          !evidence.indexDelete && !evidence.namedDeletes.has(key) && literals.every((literal) => initialMembers.get(literal)?.has(key))
      )
    )
    if (evidence.namedWrites.size === 0 && evidence.indexWrites.length === 0) {
      refuseRoot(root, 'no-writes', 'bag:no-writes')
      continue
    }
    // A member READ but never visibly written is `any`, by the same
    // degradation rule an untyped write follows (see `joined`): either no
    // write exists anywhere and every read really is `undefined` (inside
    // `any`), or a write flows through a receiver chain no census here can
    // resolve -- and `any` is what the checker answers for that read today,
    // restated at field granularity instead of refusing every OTHER member
    // over it. The bag itself still needs at least one visible write to bind
    // at all (above), so a value this census never saw touched stays refused.
    const readOnly = [...evidence.namedReads].filter((key) => !writes.has(key))
    const indexReadOnly = evidence.indexRead && evidence.indexWrites.length === 0
    // A member whose writes disagree degrades to `any` by the same
    // proportionality rule an untyped write follows in `joined`:
    // that ONE slot keeps exactly the carrier every touch of it has today,
    // instead of its conflict refusing every other member and every read of
    // the receiver itself. Nothing is guessed -- a conflicted slot is never
    // given either side's type, only the absence of a statement.
    const members = new Map<string, ts.Type>()
    for (const [key, values] of writes) {
      const type = joined(values)
      if (typeof type === 'string') memberReason.set(`${identityOf(root)}.${key}`, type)
      members.set(key, typeof type === 'string' ? checker.getAnyType() : type)
    }
    // A read of a literal key does not create a second fixed storage slot
    // when the bag already has indexed writes. That read belongs to the
    // index carrier, including its absence, just like bag[runtimeKey].
    for (const key of populated || evidence.indexWrites.length > 0 ? [] : readOnly) {
      memberReason.set(`${identityOf(root)}.${key}`, 'read-only')
      members.set(key, checker.getAnyType())
    }
    // A populated record already has a field protocol for runtime-key reads.
    // Such a read neither allocates a new property nor proves an index write.
    let index: ts.Type | null = indexReadOnly && !populated ? checker.getAnyType() : null
    if (evidence.indexWrites.length > 0) {
      const type = joined(evidence.indexWrites)
      index = typeof type === 'string' ? checker.getAnyType() : type
    }
    bound.set(root, { members, index, required })
  }

  // Type queries keep the allocation's checker identity even when there is
  // no value-flow edge to ask. Publishing only expression reads gives
  // `ReturnType<typeof factory>` the old literal fields while the factory
  // returns the augmented storage. This index publishes that same census
  // answer; unrelated structural annotations never match by field spelling.
  const shapesByType = new Map<ts.Type, ObjectBagShape | null>()
  for (const [root, shape] of bound) {
    for (const literal of literalsByOwner.get(root) ?? []) {
      if (!initialMembers.has(literal)) continue
      for (const node of [literal, root]) {
        const own = checker.getTypeAtLocation(node)
        for (const type of [own, checker.getWidenedType(own)]) {
          if ((type.flags & ts.TypeFlags.Object) === 0) continue
          const existing = shapesByType.get(type)
          shapesByType.set(type, existing === undefined || existing === shape ? shape : null)
        }
      }
    }
  }

  const absencesAt = createBagAbsenceResolver(checker, ownerDeclOfExpr, calleeDeclarationOf, writesTo, returnsOf)
  const valueShape = (root: ts.Node | null | undefined, node: ts.Node): ObjectBagShape | null => {
    let bag = root ? bound.get(root) : undefined
    const owner = ts.isExpression(node) ? ownerDeclOfExpr(node) : node
    // A stated view keeps its own type. When that type names the allocation
    // itself (including through a type query), its fields are the census's
    // fields too; otherwise no alias proof overrides the annotation.
    if (bag === undefined || (owner && declaresWrittenType(owner))) bag = shapesByType.get(checker.getTypeAtLocation(node)) ?? undefined
    return bag ? { ...bag, absences: absencesAt(node) } : null
  }

  return {
    identity: { roots: new Set(literalsByOwner.keys()), bagOf, returnsBag, conflicted, ungrounded },
    shapeForType: (type) => shapesByType.get(type) ?? null,
    shapeAt: (expression) => {
      // Deliberately NOT answered at a CALL, even though `bagRootOf` resolves
      // one internally so the bag's identity can propagate through a `return`.
      // A call's result has TWO authorities -- this node's type and the
      // callee's own resolved signature -- and `producers/invocations.ts`
      // states both from the same census on purpose. Answering here would move
      // only one of them, so the invocation producer would find the two
      // disagreeing and withhold, taking its consumers with it: MEASURED at
      // withheld 8 -> 20 and 22 operations silently gone on the three.js app, for a
      // gain of 19 carriers. The variable a call's result is bound to is
      // claimed by the propagation above and answers normally, which is where
      // the bag's uses actually are.
      if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return null
      const root = bagRootOf(expression)
      return valueShape(root, expression)
    },
    callResultShapeAt: (expression) => {
      const root = bagRootOf(expression)
      return valueShape(root, expression)
    },
    returnShapeOf: (declaration) => {
      const root = returnsBag.get(declaration)
      return valueShape(root, declaration)
    },
    // The `ts.Type` twin of `bagMemberTypeAt` below, deliberately written to
    // the same three steps in the same order -- named member, then index,
    // then nothing -- so the two cannot answer one slot two ways. The
    // widening is `getNullableType`, which is `bagSlotTypeOf`'s flat union
    // spelled in the checker's own terms: a slot holding `T | null` comes
    // back `T | null | undefined`, three distinguishable values, never a
    // carrier tagged twice.
    slotTypeAt: (expression) => {
      const named = ts.isPropertyAccessExpression(expression)
      if (!named && !ts.isElementAccessExpression(expression)) return null
      const root = bagRootOf(expression.expression)
      const bag = valueShape(root, expression.expression)
      if (!bag) return null
      const key = named ? expression.name.text : literalMemberNameOf(expression)
      const slot = (key === null ? undefined : bag.members.get(key)) ?? bag.index
      if (!slot || (slot.flags & ts.TypeFlags.Any) !== 0) return null
      return key !== null && bag.required?.has(key) ? slot : widenSlot(slot)
    },
    slotTypeOf: widenSlot,
    shapeForOwner: (declaration) => {
      const root = bagOf.get(declaration)
      return valueShape(root, declaration)
    },
    boundCount: bound.size,
    refusals: censusRefusals,
    refusalOf: (expression) => {
      const root = bagRootOf(expression)
      return root ? (refusalReason.get(root) ?? null) : null
    },
    debugReport: () => {
      const where = (node: ts.Node): string => {
        const file = node.getSourceFile()
        return `${file.fileName.split('/').slice(-1)[0]}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
      }
      const lines: string[] = []
      for (const [root, shape] of bound) {
        // EVERY member, with its carrier -- never a silent `slice`. The
        // previous form printed the first 14 keys with no ellipsis, so a bag
        // holding 46 members reported 14 and read exactly like a census that
        // had dropped 32 of them. An investigation spent a build cycle per
        // hypothesis chasing writes the census had already attributed
        // correctly; `docs/DEFECT-PATTERNS.md` section 9 is about this and the
        // instrument still did it. The interesting question a bound bag raises
        // is which SLOTS are `any`, so the types are what this prints.
        const slots = [...shape.members].map(([key, type]) => {
          const reason = memberReason.get(`${identityOf(root)}.${key}`)
          return `${key}:${checker.typeToString(type)}${reason ? `[${reason}]` : ''}`
        })
        const anySlots = [...shape.members.values()].filter((type) => (type.flags & ts.TypeFlags.Any) !== 0).length
        lines.push(
          `[BAG] BOUND ${where(root)} members=${shape.members.size} any=${anySlots} index=${shape.index ? checker.typeToString(shape.index) : '-'}`
        )
        lines.push(`[BAG]    ${slots.join(' ')}`)
      }
      for (const [root, reason] of refusalReason) {
        lines.push(`[BAG] REFUSED ${reason} ${where(root)}`)
        const evidence = evidenceOf.get(root)
        if (!evidence) continue
        for (const [key, values] of evidence.namedWrites) {
          const type = joined(values)
          lines.push(`[BAG]    ${key} <- ${typeof type === 'string' ? type : checker.typeToString(type)} (${values.length} writes)`)
        }
        for (const key of evidence.namedReads) if (!evidence.namedWrites.has(key)) lines.push(`[BAG]    ${key} <- READ-ONLY`)
        for (const value of evidence.indexWrites.slice(0, 6)) {
          const type = joined([value])
          lines.push(`[BAG]    [k] <- ${typeof type === 'string' ? type : checker.typeToString(type)}`)
        }
      }
      return lines.join('\n') + '\n'
    }
  }
}

/**
 * The `undefined`-widened spelling of ONE bag slot -- the single authority for
 * how this census states a member's type, used both by the whole-bag shape
 * below and by a member READ off that bag.
 *
 * An `any` slot (an untyped write, restated at field granularity -- see
 * `joined`) already holds every value including `undefined`; widening it would
 * union `any` with `undefined`, a spelling nobody wrote, for nothing.
 */
const bagSlotTypeOf =
  (typeOf: (type: ts.Type) => StructuralTypeId, bags: ObjectBagCensus) =>
  (type: ts.Type): StructuralTypeId =>
    typeOf(bags.slotTypeOf(type))

/**
 * A MEMBER READ off a known bag, typed by the bag rather than by the checker.
 *
 * `shapeAt` answers for the bag's OWNER aliases -- a bare identifier, or a
 * `this.field` access standing IN for the whole storage -- because that is the
 * identity `bagRootOf` keys on. It has no case for `bag.name` or `bag[ key ]`,
 * where the receiver names the bag and the NODE names one slot of it, so those
 * fell through the whole `typeAt` chain in `structural.ts` to the raw checker,
 * which for a `{}`-typed receiver answers `any`. The result was the two
 * authorities this compiler keeps rediscovering, one operation apart: the
 * struct field (or the index sidecar) is laid out NATIVELY from this same
 * census, while the GET reading it is planned `dynamic`, so the emitter
 * declares the receiving temp `gea::Value` and assigns a
 * `gea::Optional<std::string>` into it. The emitted expression text was
 * already right; only the representation selected for the read was wrong.
 *
 * The answer is the bag's own slot rule (`bagSlotTypeOf`), not a second
 * reading of it -- a named key resolves in `members`, and anything else the
 * bag admits resolves in the string-keyed `index` half, exactly as the
 * interned shape below spells them. A key the bag declares neither way answers
 * nothing and the existing fallback chain runs unchanged: this states what the
 * census already knows, it never guesses past it.
 *
 * A literal-keyed element access is a named read written with brackets --
 * `literalMemberNameOf` is the compiler's one authority for that reading and
 * is reused rather than restated here.
 */
const bagMemberTypeAt = (
  bags: ObjectBagCensus,
  typeOf: (type: ts.Type) => StructuralTypeId,
  slotTypeOf: (type: ts.Type) => StructuralTypeId,
  node: ts.Expression
): StructuralTypeId | null => {
  const named = ts.isPropertyAccessExpression(node)
  if (!named && !ts.isElementAccessExpression(node)) return null
  const bag = bags.shapeAt(node.expression)
  if (!bag) return null
  const key = named ? node.name.text : literalMemberNameOf(node)
  const member = key === null ? undefined : bag.members.get(key)
  if (member) return key !== null && bag.required?.has(key) ? typeOf(member) : slotTypeOf(member)
  return bag.index ? slotTypeOf(bag.index) : null
}

/**
 * The bag's inferred members, interned as an object shape -- the one place
 * this census's answer enters the type system.
 *
 * It lives beside the census rather than in `structural.ts` because it is the
 * bag's OWN shape rule, not a mapper rule: the optionality below is a fact
 * about how this storage is filled, and a second copy of it in the mapper
 * would be a second authority over the same question.
 *
 * Every later-added member is OPTIONAL, and its type includes `undefined`.
 * Allocation fields present in every seed retain their required status unless
 * a tracked deletion can remove them. A read of a later member that runs before
 * its write really does observe `undefined` -- `if ( bag.init === undefined )`
 * is the guard the shape exists to keep compiling. Making those later fields
 * required would erase a real absent state. A slot whose own type already carries
 * `null` is widened the same way and stays representable, because
 * `bagSlotTypeOf` builds the union FLAT -- see its own comment for the
 * measurement that settled that.
 */
export const bagShapeTypeAt = (
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  node: ts.Node
): StructuralTypeId | null => {
  // A binding's own published value is asked with the DECLARATION node, which
  // is never an expression, so the cell missed every answer below while every
  // READ of that binding -- asked with an identifier -- hit them. One storage,
  // two structural types, and the emitter then refuses (or worse, does not):
  // `const found = bag[ key ]` placed its cell as `undefined` while the read
  // filling it is `optional<string>`. The declaration states no type of its
  // own here, so its value IS its initializer's -- asking that one expression
  // is not a new rule, it is the same rule reaching the node that stands for
  // the same value.
  const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node : null
  const asked = ts.isExpression(node) ? node : ts.isVariableDeclaration(node) ? node.initializer : undefined
  const optional = bagSlotTypeOf(typeOf, bags)
  // A cell whose bag arrives by assignment rather than by its initializer --
  // see `shapeForOwner`. Asked only after the initializer, so a declaration
  // that DOES state its bag through one keeps answering exactly as before.
  // A JavaScript class field has no `PropertyDeclaration`: the checker gives
  // the field symbol the `this.field = {}` assignment itself as its sole
  // declaration. That assignment is therefore the storage declaration, not
  // merely an expression that happens to produce the bag. Treating it as the
  // latter leaves the class layout at `{}` while reads infer an index sidecar,
  // and a recursive `new Child()` write then re-enters through two different
  // carriers. `shapeForOwner` is identity-keyed and returns nothing for an
  // ordinary assignment to an existing variable, so this admits only the
  // checker-proven JS-field form rather than guessing from assignment syntax.
  const owned =
    ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || assignment !== null
      ? bags.shapeForOwner(node)
      : null
  if (asked === undefined) return owned ? internBagShape(table, typeOf, optional, owned) : null
  // `callResultShapeAt` is asked here, and only here, because this is the one
  // path whose caller declares the matching divergence
  // (`producers/invocations.ts`'s `bagResultOverride`). See that accessor's own
  // header for why `shapeAt` withholds it.
  const bag =
    bags.shapeAt(asked) ?? (ts.isCallExpression(asked) || ts.isNewExpression(asked) ? bags.callResultShapeAt(asked) : null) ?? owned
  if (!bag) return bagMemberTypeAt(bags, typeOf, optional, asked)
  return internBagShape(table, typeOf, optional, bag)
}

/** One bag shape as a structural record -- shared by both arms of `bagShapeTypeAt` so the two cannot state different layouts for one bag. */
const internBagShape = (
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  optional: (type: ts.Type) => StructuralTypeId,
  bag: ObjectBagShape
): StructuralTypeId => {
  const present = table.intern(bagStructuralShape(typeOf, optional, bag))
  return bag.absences?.length
    ? table.intern({
        kind: 'union',
        members: [present, ...bag.absences.map((primitive) => table.intern({ kind: 'primitive', primitive }))]
      })
    : present
}

const bagStructuralShape = (
  typeOf: (type: ts.Type) => StructuralTypeId,
  optional: (type: ts.Type) => StructuralTypeId,
  bag: ObjectBagShape
): StructuralShape => ({
  kind: 'object',
  membersDropped: false,
  members: [...bag.members].map(([key, type]) => ({
    key: { kind: 'string' as const, value: key },
    type: bag.required?.has(key) ? typeOf(type) : optional(type),
    optional: !bag.required?.has(key),
    readonly: false,
    accessor: null
  })),
  index: bag.index ? [{ key: 'string' as const, value: optional(bag.index), readonly: false }] : []
})

/** Type and value readers share one member/optionality publication, including recursive walks. */
export const bagShapeOfType = (
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  type: ts.Type
): StructuralShape | null => {
  const bag = bags.shapeForType(type)
  return bag ? bagStructuralShape(typeOf, bagSlotTypeOf(typeOf, bags), bag) : null
}

/** A callable and its call sites publish the identical inferred bag layout. */
export const bagReturnTypeOf = (
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  declaration: ts.Node
): StructuralTypeId | null => {
  const bag = bags.returnShapeOf(declaration)
  return bag ? internBagShape(table, typeOf, bagSlotTypeOf(typeOf, bags), bag) : null
}
