import ts from 'typescript'
import {
  annotationStatesNothing,
  exactEmptyObjectLiteralType,
  derivedExpressionType,
  disjointUnionMembersOf,
  indexedTypeOf,
  explicitThisCallReturnType,
  overloadInvariantReturnTypeAt,
  joinOfWrites as sharedJoinOfWrites,
  jsDocTypeStatesNothing,
  literalMemberNameOf,
  memberTypeOf,
  normalizedArrayConditionalType,
  objectAssignTargetType,
  isEmptyObjectType,
  synthesizedUnionArmsAt,
  unwrapExplicitThisCall,
  withoutUndefinedMember,
  widestOf
} from './derived-expression-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { emptyCollectionBindingCensus, type CollectionBindingCensus } from './collection-bindings.js'
import { emptyObjectBagCensus, type ObjectBagCensus } from './object-bag-bindings.js'
import { iteratorYieldTypesOf } from './producers/iteration-yield.js'
import {
  arrayAssignmentPatternSourceExpression,
  arrayAssignmentTargetOf,
  objectAssignmentElementOfTarget,
  objectAssignmentSource
} from './assignment-patterns.js'
import type { ValueFlowIndex } from './flow/model.js'
import { classFamilyMemberReadTypeOf } from './flow/class-family-member-read.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import { emptyCommonJsModuleRecordCensus, type CommonJsModuleRecordCensus } from './commonjs-module-record.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import { assertedReceiverArmMayLackMember } from './asserted-arm-absence.js'
import { contextTypedLiteralThisOf } from './structural-receiver.js'

/**
 * The type an unannotated `let`/`var` cell holds, when the program never
 * initializes it and fills it in later -- `let extensions, capabilities,
 * state, info;` followed by `extensions = new WebGLExtensions( _gl );` deeper
 * in the same module, three.js's `WebGLRenderer.js`'s own idiom for emulating
 * a private module scope inside one constructor.
 *
 * `parameter-bindings.ts` already computes this exact join internally
 * (`writeSetTypeOf`, gated by its own `lateAssignment` flag) but never
 * PUBLISHES it: its own header comment records why -- publishing a cell with
 * no initializer at its DECLARATION manufactured twelve new
 * `binding-read-conversion:...` obligations the one time it was tried
 * ungated. This module exists to make that publication safe rather than to
 * abandon it, by keeping the one invariant `binding-read-conversion`
 * (`preflight/obligations-graph.ts`'s `buildBindingReadObligations`) actually
 * checks: a cell's declared carrier and EVERY read's carrier must agree, or a
 * conversion obligation appears where none existed before. The failure mode
 * that produced twelve obligations was an INCONSISTENCY -- the declaration
 * answered one type and some read of the same cell answered a different one
 * (most likely because the declaration was typed but not every reference was)
 * -- not a defect in the join itself. This module answers `typeAt` for the
 * declaration AND for every read that resolves through it with the SAME
 * computation, so the two can never drift apart the way that experiment did.
 *
 * Every type this module produces comes out of the checker, at the RIGHT-HAND
 * SIDE of a real assignment the program wrote -- never invented, and never the
 * declaration's own (nonexistent) initializer.
 *
 * ## Why this needs its own resolver, not just `parameters.typeAt`
 *
 * `WebGLCapabilities`'s constructor reads `state.buffers` where `state` is
 * itself one of these late-filled cells: `parameters.typeAt` (the composed
 * parameter+return census) already walks a property access down to its
 * receiver internally, but only ever bottoms out where ITS OWN authority
 * stops -- a parameter, or (via the return census) a return expression -- and
 * answers `null` the moment the chain passes through a cell with no
 * initializer, exactly the gap this module fills. Since that walk is private
 * to `parameter-bindings.ts` and not exported, this module runs the identical
 * shape of walk itself (`return-bindings.ts`'s own `resolveLocalBinding` is
 * the precedent for doing this rather than reaching into the other file's
 * internals), asking `parameters.typeAt` FIRST at every identifier and
 * falling back to this module's own write-set resolution only where that
 * authority has nothing to say.
 *
 * ## What it refuses
 *
 * Every refusal leaves the cell exactly as it is today -- `any`, boxed --
 * because a wrong type is far worse than a boxed one:
 *
 * - an annotated declaration, one with an initializer, a destructured name, or
 *   an ambient one (`declare let x`, whose cell a host owns): none of these is
 *   this module's to type, either because the program already stated
 *   something or because `parameter-bindings.ts`'s own `writeSetTypeOf`
 *   already covers it (an initializer is present).
 * - a symbol with no assignment anywhere: a cell nothing ever writes stays
 *   exactly the checker's own answer.
 * - any write whose own type is unusable evidence (`any`/`void`/`never`) or
 *   otherwise unresolved, the identical rule every other census in this
 *   compiler applies, and a `return`/`as`/`<T>` cast is honoured at face
 *   value and never read past, matching `parameter-bindings.ts` and
 *   `return-bindings.ts`.
 * - two or more writes whose types disagree, tested the identical way two
 *   call sites or two `return`s must agree elsewhere (`widestOf`): agreement
 *   is never spelling, and a union of this compiler's own making is a guess
 *   nobody wrote. Two shapes are NOT a disagreement and are admitted by
 *   `joinOfWrites` after `widestOf` itself has refused -- a `null`/`undefined`
 *   write, which states the cell's own ABSENCE rather than a rival type
 *   (`T | null`, the `optional` carrier this compiler already has), and a set
 *   of differing LITERALS of one primitive, which is the widening
 *   TypeScript's own mutable-binding rule would have applied at a
 *   single-write declaration. See that function's own comment for both.
 * - a cell whose resolution depends on itself, directly or through another
 *   cell's own unresolved write: refused rather than looped.
 */
export interface LocalBindingCensus {
  /**
   * The type this node holds, once an unannotated `let`/`var` cell with no
   * initializer carries what its assignments (jointly) produce -- or `null`
   * when nothing here improves on the checker's/upstream census's own answer.
   *
   * Answers at a `VariableDeclaration` with no initializer (the cell's own
   * declaration, which is what `producers/bindings.ts`'s `declare` action
   * publishes as the cell's carrier) and at any node whose resolution passes
   * through one -- an identifier reading it, a property access, a call.
   */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /** This census's settled local-cell answer, without inherited expression inference. */
  readonly bindingTypeAt: (node: ts.Node) => ts.Type | null
  /** A construction-proven local type that deliberately outranks an upstream usable checker answer. */
  readonly preferredTypeAt: (node: ts.Node) => ts.Type | null
  /** The member list for a SYNTHESIZED disjoint-union carrier at this node -- see `ParameterBindingCensus.unionArmsAt`, the same rule asked of a cell's write set instead of a parameter's argument set. */
  readonly unionArmsAt: (node: ts.Node) => readonly ts.Type[] | null
  /** How many declarations this census bound, for measurement. */
  readonly boundCount: number
  /**
   * Every declaration or binding-pattern leaf this census could not bind, one
   * `CensusRefusal` each -- the owner is what makes this a list something
   * downstream can act on, rather than a count that only says a cell went
   * untyped. `census-refusal.ts`'s `censusRefusalCounts` derives the old
   * count-per-reason shape for a caller that still wants it.
   */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular declaration was not bound. */
  readonly refusalOf: (declaration: ts.VariableDeclaration) => string | null
}

/** A census that binds nothing, for callers that state no program. */
export const emptyLocalBindingCensus: LocalBindingCensus = {
  typeAt: () => null,
  bindingTypeAt: () => null,
  preferredTypeAt: () => null,
  unionArmsAt: () => null,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null
}

const isAnyType = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Any) !== 0

/** Duplicated from `parameter-bindings.ts` (not exported there): `any`/`void`/`never` say nothing about storage. */
const isUnusableEvidence = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/** Duplicated from `object-assignment.ts` (not exported there): a property name spelled as an identifier or a literal. */
const staticPropertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null

/**
 * Whether a declaration is ambient (`declare let x`, or anything nested
 * inside a `declare module`) -- duplicated from `producers/bindings.ts`'s own
 * `isAmbient` (not exported there, and that file is not this module's to
 * read internals out of): a host owns that cell, so its type is a host-
 * boundary capability question, never this module's to answer.
 */
const isAmbientDeclaration = (node: ts.Node): boolean => {
  if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0) return true
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * Whether this declaration is the exact shape this module types: unannotated,
 * a plain identifier name, not ambient, and a cell TypeScript itself could not
 * type.
 *
 * ## Why an initializer is not a disqualification
 *
 * `!declaration.initializer` was the original test, on the reasoning that a
 * cell WITH an initializer is one TypeScript already typed. That reasoning is
 * right about the ordinary case and wrong about the case this module exists
 * for. `const image = resizeImage( texture.image, false, ... )` has an
 * initializer, and the checker types the cell `any` -- because the initializer
 * is a call into a function whose own return type it could not name. The cell
 * is no better described than `let image;` would have been; it was simply
 * excluded from the census on the strength of a syntactic property that does
 * not answer the question being asked.
 *
 * So the test is the checker's ANSWER, not the syntax. An initialized cell is
 * a candidate when `checker.getTypeAtLocation` on it is unusable evidence, or
 * when it is mutable and a later assignment proves that answer cannot be its
 * storage type. The second case matters in JavaScript: TypeScript may describe
 * `let id = match[1]` as `string` at the declaration even when the same cell is
 * later assigned a number. The flow index supplies the complete write set, so
 * admitting that declaration is evidence-driven rather than a widening guess.
 * Where every later write fits the checker's answer, the initialized cell
 * remains outside this census -- which is the ordinary typed-program case.
 *
 * The initializer then joins the write set (`resolveDeclaration`) rather than
 * being read on its own: it is one write among however many assignments
 * follow, and reading it alone would describe a value the program does not
 * have -- the same two-authorities-on-one-cell defect
 * `parameter-bindings.ts`'s `writeSetTypeOf` header describes.
 *
 * "Unannotated" includes a JSDoc `@type` tag that resolves to nothing. The
 * tag's presence was the old test, and it is the wrong one: the checker
 * degrades a JSDoc node naming an unbindable type to `any`, so a cell the
 * program DID describe is excluded from this census and then carries
 * `dynamic(declared-any-never-narrowed)` -- recorded as declared dynamic when
 * the program declared the opposite. `parameter-bindings.ts` has drawn this
 * distinction since the call-site census landed; this is the same predicate,
 * shared rather than copied.
 *
 * Measured on the three.js app: ZERO uninitialized locals carry a JSDoc type at all, so
 * this changes nothing there today. It is landed for the symmetry, not for a
 * number -- the three censuses answering one question three different ways is
 * how the return-side gap survived, and leaving one of them holding the old
 * test preserves the trap for whichever program hits it first.
 */
/**
 * Whether a WRITTEN type annotation actually states something, rather than
 * merely occupying the syntax position -- the same distinction
 * `jsDocTypeStatesNothing` draws for a JSDoc tag, drawn slightly more
 * conservatively here because this is a real TypeScript annotation rather
 * than a degraded doc comment: the literal `any`/`unknown` keyword is left
 * alone (`true`, genuinely stated) because a program that writes that down
 * is declaring the cell dynamic on purpose -- CLAUDE.md's own carve-out for
 * a value the program declares `any`/`unknown` and never narrows, and this
 * module must not talk it out of that. Anything else that merely EVALUATES
 * to `any`/`unknown` through the type system -- a utility type applied to a
 * library's own erased generic, `ReturnType<H>` over hono's `H = Handler |
 * MiddlewareHandler` being the concrete case -- states nothing a reader
 * could act on, and is treated as if the position were bare.
 */
const annotationIsGenuinelyStated = (checker: ts.TypeChecker, typeNode: ts.TypeNode): boolean => {
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword) return true
  const resolved = checker.getTypeFromTypeNode(typeNode)
  return (resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
}

const isCandidate = (checker: ts.TypeChecker, declaration: ts.VariableDeclaration, flow: ValueFlowIndex): boolean => {
  if (declaration.type && annotationIsGenuinelyStated(checker, declaration.type)) return false
  if (!ts.isIdentifier(declaration.name)) return false
  const jsDocType = ts.getJSDocType(declaration)
  if (jsDocType && !jsDocTypeStatesNothing(checker, jsDocType)) return false
  if (isAmbientDeclaration(declaration)) return false
  if (declaration.initializer) {
    const declared = checker.getTypeAtLocation(declaration)
    if (!isUnusableEvidence(declared)) {
      const declarationList = declaration.parent
      if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) !== 0) return false
      const symbol = checker.getSymbolAtLocation(declaration.name)
      if (!symbol) return false
      const hasDivergentAssignment = flow.writesToSymbol(symbol).some((write) => {
        if (write.slot !== 'whole' || write.edge !== 'identifier-assignment' || write.value === null) return false
        const assigned = checker.getTypeAtLocation(write.value)
        return !isUnusableEvidence(assigned) && !checker.isTypeAssignableTo(assigned, declared)
      })
      if (!hasDivergentAssignment) return false
    }
  }
  return true
}

/**
 * Whether one LEAF of a binding pattern -- one member of `const {a,b} = o`,
 * one element of `const [a,b] = t`, the loop variable of `for (const x of
 * xs)` when it is itself a pattern -- is this module's to type: a plain
 * identifier name (a nested pattern is not itself a leaf; ITS OWN elements
 * are the leaves, reached by the same walk one level deeper), not a rest
 * element (`{...rest}`/`[...rest]` names a NEW shape -- an object/array of
 * the remaining keys -- not a projection of one member), not ambient, and a
 * cell TypeScript itself could not already type. The identical "ask the
 * checker's own answer, not the syntax" rule `isCandidate` applies to a
 * `VariableDeclaration`'s own name, applied here to a pattern's leaf instead
 * -- rows 14 (object destructuring), 15 (array destructuring), 16
 * (destructuring defaults) and the destructured half of row 22 (for-of) are
 * this ONE predicate plus `resolveBindingElement`'s one recursive resolver,
 * not four separate arms.
 */
const isElementCandidate = (checker: ts.TypeChecker, element: ts.BindingElement): boolean => {
  if (!ts.isIdentifier(element.name)) return false
  if (isAmbientDeclaration(element)) return false
  // An object rest over an open dictionary keeps the source's unknown key set,
  // even when TypeScript reports the post-exclusion view as the usable-looking
  // but physically empty `{}`. `resolveBindingElement` proves the index below.
  if (element.dotDotDotToken && ts.isObjectBindingPattern(element.parent)) return true
  if (element.dotDotDotToken) return false
  return isUnusableEvidence(checker.getTypeAtLocation(element.name))
}

/** A function-like declaration whose own `return` statements this module may read. Duplicated from `return-bindings.ts` (not exported there) -- see its own copy's comment. */
type ReturnEvidenceOwner =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration

const isReturnEvidenceOwner = (node: ts.Node): node is ReturnEvidenceOwner =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node)

/** Every syntax kind that owns its OWN `return`s -- a walk collecting one function's returns must stop at the next one's boundary. Duplicated from `return-bindings.ts`'s `isScopeBoundary` for the same reason. */
const isReturnEvidenceScopeBoundary = (node: ts.Node): boolean =>
  isReturnEvidenceOwner(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isClassExpression(node) ||
  ts.isClassStaticBlockDeclaration(node)

const hasAsyncOrGeneratorModifier = (owner: ReturnEvidenceOwner): boolean => {
  const async =
    (ts.canHaveModifiers(owner) ? ts.getModifiers(owner) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
    false
  const generator = 'asteriskToken' in owner && owner.asteriskToken !== undefined
  return async || generator
}

/** Whether `symbol` is read anywhere inside this expression, by exact symbol identity (never by spelling, so a shadowed same-named binding elsewhere never matches). */
const expressionReadsSymbol = (checker: ts.TypeChecker, expression: ts.Expression, symbol: ts.Symbol): boolean => {
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(expression)
  return found
}

/**
 * The type a cell holds, read BACKWARD from the enclosing function's own
 * STATED return type -- the one case the write side (`resolveDeclaration`'s
 * own `writes`/`widestOf` machinery) can never resolve: every write is
 * itself a call whose callee the checker could not type, because the
 * callee's own signature return is `any` for a reason internal to the
 * library that declared it (an erased generic default) rather than for any
 * fact about THIS program. hono's `hono-base.ts`:
 *
 *   #dispatch(...): Response | Promise<Response> {
 *     let res: ReturnType<H>
 *     try { res = matchResult[0][0][0][0](c, next) } catch (err) { ... }
 *     return res instanceof Promise ? res.then(...) : (res ?? ...)
 *   }
 *
 * is the concrete case: `H = Handler | MiddlewareHandler` (`types.ts`)
 * defaults its own trailing type parameter to the literal `any`, and
 * TypeScript's own union-with-`any` rule collapses `any | Promise<R | void>`
 * to plain `any` -- a TypeScript typing rule, not a physical fact about
 * what the call returns. Nothing at the WRITE reaches past that; `#dispatch`
 * itself, though, states in its own signature exactly what its `return`
 * hands back, and `res` is the one value that statement is built from -- so
 * the function's own annotation is real evidence for the cell that feeds
 * it, symmetric to `return-bindings.ts`'s own direction (a STATED return
 * infers an unstated variable, rather than unstated returns inferring a
 * declaration `return-bindings.ts` itself refuses to touch a function that
 * already states its own return type, for the identical reason this module
 * must not invent one where a real annotation stands -- this is the
 * complementary gap: the FUNCTION stated a type, and an internal CELL
 * feeding its `return` did not).
 *
 * Gated tightly, because the checker performs no assignability check at an
 * `any`-typed expression and a wrong answer here is worse than staying
 * dynamic:
 *  - the enclosing function/method must be a plain, non-async,
 *    non-generator function with a body block and a REAL stated return
 *    annotation of its own (never itself `any`/`unknown`/`void`/`never`) --
 *    an async function's own `return` hands back the AWAITED value, not the
 *    `Promise<T>` its signature states, so this refuses async and generator
 *    functions outright, the same exclusion `return-bindings.ts` documents
 *    for the identical reason;
 *  - the cell's own symbol must be read, by exact symbol identity, inside a
 *    `return` statement's own expression belonging to that SAME function --
 *    never a nested closure's, which owns its own returns;
 *  - only ever a FALLBACK, tried from `resolveDeclaration` after every
 *    write has already failed to resolve through the ordinary route: a cell
 *    whose writes DO resolve, even to a value that disagrees with the
 *    return, keeps disagreeing rather than being silently overridden here.
 */
const declaredReturnEvidenceFor = (checker: ts.TypeChecker, declaration: ts.VariableDeclaration, symbol: ts.Symbol): ts.Type | null => {
  let owner: ts.Node | undefined = declaration.parent
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
  if (!owner || !isReturnEvidenceOwner(owner)) return null
  if (hasAsyncOrGeneratorModifier(owner)) return null
  const body = owner.body
  if (!body || !ts.isBlock(body)) return null
  if (!owner.type) return null
  const declaredReturn = checker.getTypeFromTypeNode(owner.type)
  if (isUnusableEvidence(declaredReturn)) return null
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (node !== body && isReturnEvidenceScopeBoundary(node)) return
    if (ts.isReturnStatement(node) && node.expression && expressionReadsSymbol(checker, node.expression, symbol)) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(body)
  return found ? declaredReturn : null
}

/**
 * Whole-program census of what every unannotated, uninitialized `let`/`var`
 * cell holds, once every assignment to it agrees.
 *
 * `parameters` is the ALREADY-SETTLED, composed parameter+return census
 * (`withReturnBindings(...)`, or `emptyParameterBindingCensus` when none is
 * available) -- asked first at every identifier, exactly as `return-bindings.
 * ts`'s own local resolver asks it first. This module never reopens that
 * fixpoint; it only adds what neither authority could answer because the
 * chain passed through a cell with no initializer.
 */
export const censusLocalBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  /** The same-round array census -- see `return-bindings.ts`'s identical parameter for why, and `frontend.ts`'s `compose`. */
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  /**
   * The whole-program value-flow index -- the ONE walk that states where every
   * write is. This module's own private write-discovery walk
   * (`assignmentsBySymbol`) reads its edges from it rather than re-deriving
   * them; see `flow/model.ts`. An edge-SOURCE swap: the policy below (which
   * writes are evidence, how they join) is unchanged.
   */
  flow: ValueFlowIndex,
  /**
   * The same-round property-bag census. Consulted where a WRITE or an
   * initializer reads one slot off a tracked bag -- `bag.name`, `bag[ k ]` --
   * as `slotTypeAt`, the one question about a bag whose answer is a plain
   * `ts.Type` and so the only one this module can consume. See that
   * accessor's own header.
   */
  bags: ObjectBagCensus = emptyObjectBagCensus,
  /**
   * The prior OUTER composed view. `parameters` above is the newly rebuilt
   * parameter+return stage and intentionally contains only those domains; it
   * cannot carry this local census's own synthesized arms back to itself.
   * This input is used only as the previous element of the local arm lattice.
   */
  prior: ParameterBindingCensus = emptyParameterBindingCensus,
  /** Exact, authenticated `module.exports = callable` proofs for this program's CommonJS modules. */
  moduleRecords: CommonJsModuleRecordCensus = emptyCommonJsModuleRecordCensus
): LocalBindingCensus => {
  /**
   * Every `symbol = expr` write this program makes (its own declaration's
   * initializer included), read from the shared value-flow index. Used to be
   * a private walk of this file's own; `declaration-initializer` and
   * `identifier-assignment` are exactly the two edges that walk recognised.
   *
   * ⛔ Deliberately NOT widened to admit `object-assign` here (H3 in the
   * fleet brief). ADDENDUM 3: the index's `object-assign` edge is matched by
   * the library spelling `Object.assign`, the same defect this campaign is
   * closing one layer down -- `fCALL` owns `flow/` and is replacing it with a
   * generic `call(callee, args) -> value` primitive whose write-through is a
   * property of the resolved callee, never of its name. Hand-widening this
   * census to admit the old, spelling-matched edge would be patching the
   * consumer instead of fixing the authority; once fCALL's primitive lands,
   * this reads whatever it publishes with no change of its own.
   */
  /**
   * One write this module found evidence for. `node` is always a real
   * `ts.Node` -- the same currency `known`/`resolveExpr`/`nodeMemo`/
   * `writeAnswers` already key on -- so every existing consumer of this
   * evidence keeps working unchanged. `resolvedType`, when present, is a
   * type this module already derived itself and the caller must use AS-IS
   * rather than asking the checker to re-type `node`: the ONE shape with no
   * backing expression to type is a for-of/for-in loop-head pattern's
   * per-position write (`forOfPatternElementTypeAt`), where `node` is kept
   * only as the pattern's own written identifier -- a real node for
   * memoization/debugging, never itself the source of the value.
   */
  interface CellWrite {
    readonly node: ts.Expression
    readonly resolvedType?: ts.Type
  }

  const identifierWritesOf = (symbol: ts.Symbol): readonly CellWrite[] => {
    const writes: CellWrite[] = []
    for (const write of flow.writesToSymbol(symbol)) {
      if (write.slot !== 'whole') continue
      if (write.value !== null && (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment')) {
        writes.push({ node: write.value })
        continue
      }
      // `[a] = [1, 2, 3]` / `({ a } = { a: 1 })` -- a destructuring ASSIGNMENT
      // writes a bare, previously-untyped cell exactly the way `a = expr`
      // does, but `recordAssignmentPattern` (`flow/value-flow.ts`) records it
      // with `value: null`: a pattern's target is not itself the source of
      // its own value the way an ordinary assignment's left side is. The
      // default's own value (`destructuring-default`, `[x = 3] = ...`) IS a
      // real expression already -- `inner.right` -- so it needs no recovery.
      if (write.value !== null && write.edge === 'destructuring-default') {
        writes.push({ node: write.value })
        continue
      }
      if (write.edge === 'destructuring' && write.value === null && write.naming) {
        const evidence = destructuringAssignmentEvidenceExpressionAt(write.naming)
        if (evidence) {
          writes.push({ node: evidence })
          continue
        }
        // A for-of/for-in LOOP-HEAD pattern (`for ([a, b] of pairs)`) has no
        // literal source `destructuringAssignmentEvidenceExpressionAt` could
        // index into -- the value comes from the loop's own iteration, never
        // from an expression the program wrote. `forOfPatternElementTypeAt`
        // derives the per-position/per-key type directly from the loop's own
        // iterable (or, for a for-in head, its key string).
        const patternType = forOfPatternElementTypeAt(write.naming)
        if (patternType) writes.push({ node: write.naming, resolvedType: patternType })
        continue
      }
      // `var v; for (v of xs) ...` -- a bare identifier reused as a for-of/
      // for-in loop's own head, declared OUTSIDE the loop. See
      // `forOfBareIdentifierElementTypeAt`'s own header for why this is a
      // separate case from both the destructuring-pattern head above and
      // `forOfElementType`'s declared-in-loop binding.
      if (write.edge === 'iteration-binding' && write.value === null && write.naming) {
        const elementType = forOfBareIdentifierElementTypeAt(write.naming)
        if (elementType) writes.push({ node: write.naming, resolvedType: elementType })
      }
      // `catch (err) { ... }` -- the binding's value is the thrown exception,
      // never an expression this program wrote, exactly as a for-of/for-in
      // loop's own head is not. `Catch(C, thrownValue)` (ECMA-262 14.15.2)
      // BINDS the caught value with no further coercion, and this compiler's
      // own dynamic-boundary rule already names "a thrown JS error carrier"
      // as one of the genuinely dynamic values a program is allowed to leave
      // unnarrowed -- so the checker's own type at the binding (`unknown`
      // under `useUnknownInCatchVariables`, or whatever explicit annotation
      // the program wrote, e.g. `catch (err: SomeError)`) is the answer, not
      // a refusal. Before this, a caught error that the handler only ever
      // READ (never reassigned -- the overwhelmingly common shape) found no
      // evidence at all and refused as
      // `no-writes:existence-only:catch-binding`, in this program and in
      // hono's own `#handleError`.
      if (write.edge === 'catch-binding' && write.value === null && write.naming) {
        writes.push({ node: write.naming, resolvedType: checker.getTypeAtLocation(write.naming) })
      }
    }
    return writes
  }

  /**
   * The real sub-expression backing a destructuring-ASSIGNMENT write with no
   * recorded value: the array-literal element at the same position, or the
   * object-literal property with the same name -- asked of whichever literal
   * the program actually wrote on the right, never invented. `known`/
   * `resolveExpr` need a `ts.Expression` to ask the checker about, the same
   * currency every other edge already supplies; this recovers one for the
   * one shape the flow index could not attach a value to.
   *
   * Refuses a REST target (no single element states "the rest") and any
   * source that is not itself a literal (there is no sound way to index INTO
   * an arbitrary expression's type without `checker.createArrayType`, which
   * is checker-internal -- `structural-array-element.ts`'s header documents
   * the identical wall for `never[]`). Both stay exactly as boxed as they are
   * today; a wrong answer would be worse than a boxed one.
   */
  const destructuringAssignmentEvidenceExpressionAt = (target: ts.Expression): ts.Expression | null => {
    const arrayTarget = arrayAssignmentTargetOf(target)
    if (arrayTarget) {
      if (ts.isSpreadElement(arrayTarget.keyNode)) return null
      const source = arrayAssignmentPatternSourceExpression(arrayTarget.pattern)
      if (!source || !ts.isArrayLiteralExpression(source)) return null
      const element = source.elements[arrayTarget.position]
      return element && !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) ? element : null
    }
    const objectElement = objectAssignmentElementOfTarget(target)
    if (!objectElement) return null
    const pattern = objectElement.parent
    if (!ts.isObjectLiteralExpression(pattern)) return null
    const source = objectAssignmentSource(pattern)
    if (!source || !ts.isObjectLiteralExpression(source)) return null
    const keyName = ts.isShorthandPropertyAssignment(objectElement) ? objectElement.name.text : staticPropertyName(objectElement.name)
    if (keyName === null) return null
    for (const property of source.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
      if (staticPropertyName(property.name) !== keyName) continue
      return ts.isPropertyAssignment(property) ? property.initializer : property.name
    }
    return null
  }

  /**
   * Why a cell `identifierWritesOf` found no VALUED write for has no evidence.
   *
   * `no-writes` was a single bucket, and it is half of every refusal any
   * census in this compiler reports (3201 of 6340 on the largest measured
   * program). A bucket that size is a measurement failure before it is a
   * compiler one: it held four unrelated situations, which want four
   * different answers and only one of which is "nothing writes this cell".
   *
   * - `none`: the index knows no write to the cell at all, and it has no
   *   initializer. In JavaScript such a cell holds exactly `undefined`
   *   forever, so this is answerable -- but only if the whole program really
   *   is in view, which is why it is REPORTED rather than assumed here.
   * - `initializer-unseen`: the declaration HAS an initializer that the index
   *   did not attribute to this symbol. That is an index defect, never a
   *   property of the program.
   * - `existence-only:<edges>`: every write states only that the slot exists
   *   (`flow/model.ts` records `value: null` for these) -- a `catch` binding,
   *   a `for..of` binding this module's `forOfElementType` could not open, a
   *   destructured element, a compound assignment. Each is a real edge with a
   *   real value; the value simply is not the recorded expression, so naming
   *   the edge names what to teach next.
   * - `member-only`: nothing writes the cell as a whole, only its members or
   *   elements. The cell is a bag or a container, and its shape is another
   *   census's answer (`object-bag-bindings.ts`, `collection-bindings.ts`) --
   *   this one having no answer is correct.
   */
  const noEvidenceReason = (symbol: ts.Symbol, declaration: ts.VariableDeclaration): string => {
    const all = flow.writesToSymbol(symbol)
    const whole = all.filter((write) => write.slot === 'whole')
    if (whole.length === 0) {
      if (declaration.initializer) return 'no-writes:initializer-unseen'
      return all.length === 0 ? 'no-writes:none' : 'no-writes:member-only'
    }
    const edges = [...new Set(whole.map((write) => write.edge))].sort().join('+')
    return `no-writes:existence-only:${edges}`
  }

  const bound = new Map<ts.VariableDeclaration, ts.Type>()
  /** The synthesized union arms for a cell whose writes disagree but disjointly -- see `resolveDeclaration`. */
  const unionArms = new Map<ts.VariableDeclaration, readonly ts.Type[]>()
  const refusalOf = new Map<ts.VariableDeclaration, string>()
  const resolvingDeclarations = new Set<ts.VariableDeclaration>()
  /** Whether resolution is in the relaxed retry phase, where a silent write is an absence rather than a veto. See `resolveDeclaration`. */
  let lenientPhase = false

  /**
   * The checker's own answer at this node, when it says something usable.
   * `annotationStatesNothing` is part of the test for the reason
   * `field-bindings.ts`'s own `known` documents at length: a vacuous type
   * (`Object`, `{}`, bare `object`) is not just non-evidence -- fed to a
   * `widestOf` join it DOMINATES, because every type is assignable to it, so
   * one vacuous write out-votes every real one. The layout resolver already
   * asks both halves of the question; a census asking only one is drift.
   */
  const known = (node: ts.Node): ts.Type | null => {
    const exported = moduleRecords.exportExpressionAt(node) ?? moduleRecords.requiredExportExpressionAt(node)
    const type = exported ? checker.getTypeAtLocation(exported) : (objectAssignTargetType(checker, node) ?? checker.getTypeAtLocation(node))
    return isUnusableEvidence(type) || annotationStatesNothing(checker, node, type) ? null : type
  }

  /**
   * Materialize an already-proved synthesized union for INTERNAL resolution.
   *
   * The public census keeps synthesized unions in `unionArmsAt`, because the
   * structural mapper consumes the arm list directly. Recursive census
   * resolution still needs one `ts.Type` to ask ordinary checker questions
   * such as “what is this union's common member?” and “what does that member
   * return?”. Without this bridge, a union published in one outer round was
   * unreadable in the next: the local census fell back to its pre-union
   * answer, then rediscovered the union one round later, forever.
   *
   * This is the same guarded checker reach used by
   * `disjointUnionTypeOf`/`parameter-slot.ts`. Failure remains a refusal; no
   * alternate union implementation is invented here.
   */
  /** A carrier that states a DYNAMIC boundary rather than a type -- see `branchArmsOf`. */
  const DYNAMIC_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown

  /**
   * The two values a BRANCHING write can store -- `value || "u"`, `a ?? b`,
   * `cond ? x : y`.
   *
   * `derivedExpressionType` answers such an expression with the ONE type both
   * operands agree on, and `null` when they disagree: for a join that is the
   * honest answer, but for a WRITE it reads as silence, and the relaxed phase
   * drops a silent write rather than letting it disagree. A cell written
   * `f || "u"` in one place and `"q"` in another was then placed as
   * `std::string` -- and the branching write, whose value really can be the
   * function, was stored through a fail-open unbox that aborted at runtime
   * (test262's propertyHelper `isWritable`, whose `value || unlikelyValue` is
   * a function at `verifyNotWritable`'s call sites).
   *
   * Both operands ARE the write set -- the same reading `derivedExpressionType`
   * already gives a ternary's two arms in its own comment -- so they are
   * contributed as arms here, and the ordinary arm lattice decides whether
   * they become one type, a synthesized union, or a dynamic cell. `&&` is
   * excluded: its value
   * is the right operand or the LEFT's falsy state, which is a narrowing of
   * the left rather than the left itself.
   */
  const branchArmsOf = (node: ts.Node): readonly ts.Type[] | null => {
    const branches = ts.isConditionalExpression(node)
      ? ([node.whenTrue, node.whenFalse] as const)
      : ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        ? ([node.left, node.right] as const)
        : null
    if (!branches) return null
    // A DYNAMIC operand is evidence too, and the evidence is that the cell is
    // dynamic: `value || "u"` where `value` is bound `any` by its call sites
    // stores the box, and dropping that arm placed the cell from the other
    // write alone -- the fail-open unbox this rule exists to stop. The arm
    // lattice reads an `any` arm as the whole cell (`carriesNoEvidence`
    // vetoes a union carrying one), which is the honest answer. Only an
    // operand nobody could type at all is still silence.
    const arms = branches.map((branch) => knownOrResolve(branch))
    if (arms.every((arm): arm is ts.Type => arm !== null)) return arms
    // An operand NO authority can type, whose checker answer is `any`, is a
    // genuinely dynamic boundary rather than silence -- the same reading
    // `parameter-bindings.ts`'s `isSuppliedDynamic` gives a supplied `any`.
    // The storage really does hold the box, so the expression's own `any` is
    // contributed as the arm: the cell goes dynamic instead of being placed
    // from the OTHER write and reading this one back through a fail-open
    // unbox. (`verifyProp || name`, `value || unlikelyValue` -- test262's
    // propertyHelper, whose parameters are bound by call sites that disagree
    // in arity.)
    const dynamicOperand = branches.some((branch) => (checker.getTypeAtLocation(branch).flags & DYNAMIC_FLAGS) !== 0)
    if (!dynamicOperand) return null
    const own = checker.getTypeAtLocation(node)
    return (own.flags & DYNAMIC_FLAGS) !== 0 ? [own] : null
  }

  const unionTypeOf = (arms: readonly ts.Type[] | null): ts.Type | null => {
    if (!arms || arms.length === 0) return null
    const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
    return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(arms) : null
  }

  /** Whether the checker's raw answer at a write is a REAL fact refusing storage (`void`/`never`), as opposed to silence. */
  const statesNoStorage = (node: ts.Node): boolean =>
    (checker.getTypeAtLocation(node).flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

  /** Node-level memo/cycle-guard for the general resolver below -- a property-access chain can revisit the same sub-expression more than once. */
  const nodeMemo = new Map<ts.Node, ts.Type | null>()
  const nodeResolving = new Set<ts.Node>()
  /**
   * A silent write's own answer, once its cell resolved via
   * `declaredReturnEvidenceFor` -- deliberately a SEPARATE map from
   * `nodeMemo`, which the lenient retry below clears every round on purpose
   * (stale `null`s from a smaller view must not survive to the next). A
   * declaration bound in the strict phase is never revisited (`resolveDeclaration`
   * returns `already` before it would run the backfill again), so an answer
   * recorded only in `nodeMemo` is erased by the very next round's `clear()`
   * and never restored -- measured directly: hono's `res = matchResult[0][0]
   * [0][0](c, next)` backfilled correctly, then read back as the stale `null`
   * `compute` had cached before the backfill, because a LATER declaration's
   * lenient retry cleared `nodeMemo` in between the write and the query. This
   * map is never cleared, so the write keeps the cell's answer regardless of
   * how many other declarations retry around it.
   */
  const writeAnswers = new Map<ts.Node, ts.Type>()
  // The closed-family fallback is the parameter census's own rule, asked the
  // same way -- see `flow/class-family-member-read.ts`.
  const propertyTypeOf = (receiver: ts.Type, name: string, at: ts.Node): ts.Type | null =>
    memberTypeOf(checker, receiver, name, at, flow) ?? classFamilyMemberReadTypeOf(checker, flow, receiver, name, parameters)

  const declarationOf = (node: ts.Identifier): ts.VariableDeclaration | null => {
    const symbol = checker.getSymbolAtLocation(node)
    const declarations = symbol?.declarations
    const declaration = declarations && declarations.length === 1 ? declarations[0] : undefined
    return declaration && ts.isVariableDeclaration(declaration) ? declaration : null
  }

  /** Synthesized arms visible while resolving this census, upstream first. */
  const unionArmsForResolution = (node: ts.Node): readonly ts.Type[] | null => {
    const upstream = parameters.unionArmsAt(node) ?? prior.unionArmsAt(node)
    if (upstream) return upstream
    const declaration = ts.isVariableDeclaration(node) ? node : ts.isIdentifier(node) ? declarationOf(node) : null
    return declaration ? (unionArms.get(declaration) ?? null) : null
  }

  /**
   * Project one property through a synthesized union without manufacturing a
   * union of callable views. A property is available only on every present
   * constituent; its result is the same ordinary widest-type join used for
   * writes everywhere else in this census.
   *
   * Asking `checker.getPropertyOfType` on the materialized whole union is not
   * equivalent. For two subclasses inheriting one method, TypeScript can
   * return a union of per-arm function views. That object has multiple call
   * signatures, so the next round refuses a call that the previous round had
   * resolved and the census oscillates. Arm-wise projection observes that
   * both views are the same assignable convention and returns one stable
   * method type. Nullish constituents are absence, matching
   * `memberTypeOf`'s existing `getNonNullableType` rule.
   */
  const unionMemberTypeOf = (arms: readonly ts.Type[], name: string, at: ts.Node): ts.Type | null => {
    const members: ts.Type[] = []
    for (const arm of arms.flatMap((type) => (type.isUnion() ? type.types : [type]))) {
      if ((arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) continue
      const member = memberTypeOf(checker, arm, name, at)
      if (!member) return null
      members.push(member)
    }
    return members.length > 0 ? widestOf(checker, members) : null
  }

  /**
   * The exact nodes sharing an inferred indexed read whose absence the program
   * observes one statement later.
   *
   * With `noUncheckedIndexedAccess` off, TypeScript gives
   *
   *   let item = items[index]
   *   if (item === undefined) item = makeItem()
   *
   * the bare element type at both the initializer and comparison. JavaScript
   * still produces `undefined` for a hole or an out-of-range index. A
   * dictionary has the same gap when a missing key is tested for truthiness:
   * its unchecked index signature says `T`, while JavaScript returns
   * `undefined`. The property producer already knows how to emit both optional
   * reads; this map supplies the missing fact across the local binding.
   *
   * Only the declaration, initializer and direct comparison references are
   * widened. Reads after the fallback assignment keep the checker's narrowed
   * element type, as do indexed reads whose absence is not observed.
   */
  const observedIndexedAbsence = new Map<ts.Node, ts.Type>()

  const directUndefinedComparison = (expression: ts.Expression): boolean => {
    let inner: ts.Node = expression
    let parent = inner.parent
    while (parent && ts.isParenthesizedExpression(parent)) {
      inner = parent
      parent = parent.parent
    }
    if (!parent || !ts.isBinaryExpression(parent)) return false
    const operator = parent.operatorToken.kind
    if (
      operator !== ts.SyntaxKind.EqualsEqualsToken &&
      operator !== ts.SyntaxKind.ExclamationEqualsToken &&
      operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    )
      return false
    const other = parent.left === inner ? parent.right : parent.right === inner ? parent.left : null
    return other !== null && (checker.getTypeAtLocation(other).flags & ts.TypeFlags.Undefined) !== 0
  }

  /** Whether this reference is consumed directly by ToBoolean. */
  const directTruthinessTest = (expression: ts.Expression): boolean => {
    let inner: ts.Node = expression
    let parent = inner.parent
    while (parent && ts.isParenthesizedExpression(parent)) {
      inner = parent
      parent = parent.parent
    }
    if (!parent) return false
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === inner
    if (ts.isForStatement(parent)) return parent.condition === inner
    if (ts.isConditionalExpression(parent)) return parent.condition === inner
    if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken
    if (!ts.isBinaryExpression(parent) || parent.left !== inner) return false
    return (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  }

  const registerObservedIndexedAbsence = (declaration: ts.VariableDeclaration): void => {
    if (declaration.type || ts.getJSDocType(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer) return
    let initializer: ts.Expression = declaration.initializer
    while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression
    if (!ts.isElementAccessExpression(initializer) && !ts.isPropertyAccessExpression(initializer)) return
    const key = ts.isElementAccessExpression(initializer) ? checker.getTypeAtLocation(initializer.argumentExpression) : null
    const receiver = checker.getTypeAtLocation(initializer.expression)
    const constituents = receiver.isUnion() ? receiver.types : [receiver]
    const arrayRead =
      key !== null &&
      (key.flags & ts.TypeFlags.NumberLike) !== 0 &&
      constituents.every((member) => checker.isArrayType(member) && !checker.isTupleType(member))
    const indexKind = key !== null && (key.flags & ts.TypeFlags.NumberLike) !== 0 ? ts.IndexKind.Number : ts.IndexKind.String
    const dictionaryRead = constituents.every(
      (member) =>
        checker.getIndexTypeOfType(checker.getNonNullableType(member), indexKind) !== undefined &&
        // A declared field has its own presence contract. Only a name resolved
        // through the index signature shares a computed lookup's missing key.
        (!ts.isPropertyAccessExpression(initializer) || checker.getPropertyOfType(member, initializer.name.text) === undefined)
    )
    // The same gap for a named read through an `as` whose value's real arms
    // may lack the member (`asserted-arm-absence.ts`): the checker types the
    // cell as the asserted arm's member, and JavaScript reads `undefined`.
    const assertedRead =
      ts.isPropertyAccessExpression(initializer) &&
      assertedReceiverArmMayLackMember(checker, initializer, (receiver) => checker.getTypeAtLocation(receiver))
    if (!arrayRead && !dictionaryRead && !assertedRead) return
    const value = checker.getTypeAtLocation(initializer)
    if (isUnusableEvidence(value) || (value.flags & ts.TypeFlags.Unknown) !== 0) return
    const symbol = checker.getSymbolAtLocation(declaration.name)
    if (!symbol) return
    const observing = flow
      .referencesToSymbol(symbol)
      .filter((reference) => directUndefinedComparison(reference) || directTruthinessTest(reference))
    if (observing.length === 0) return
    const optional = checker.getNullableType(value, ts.TypeFlags.Undefined)
    observedIndexedAbsence.set(declaration, optional)
    observedIndexedAbsence.set(declaration.name, optional)
    observedIndexedAbsence.set(declaration.initializer, optional)
    observedIndexedAbsence.set(initializer, optional)
    for (const reference of observing) observedIndexedAbsence.set(reference, optional)
  }

  /** The identical lookup as `declarationOf`, for an identifier whose sole declaration is a binding-pattern LEAF rather than a plain `VariableDeclaration`. */
  const bindingElementDeclarationOf = (node: ts.Identifier): ts.BindingElement | null => {
    const symbol = checker.getSymbolAtLocation(node)
    const declarations = symbol?.declarations
    const declaration = declarations && declarations.length === 1 ? declarations[0] : undefined
    return declaration && ts.isBindingElement(declaration) ? declaration : null
  }

  const attribute = (declaration: ts.VariableDeclaration, reason: string): null => {
    if (!refusalOf.has(declaration)) refusalOf.set(declaration, reason)
    return null
  }

  /**
   * The join of this cell's write set. `derived-expression-type.ts`'s
   * `joinOfWrites` is the one rule -- `widestOf` first and unchanged, then a
   * nullish write read as ABSENCE and a differing-literal set widened to its
   * primitive. It lives there rather than here because `field-bindings.ts`
   * asks the identical question of a class field, and a field written `null`
   * in the constructor and filled in later is exactly the shape this landed
   * for; see that function's own comment.
   */
  const joinOfWrites = (types: readonly ts.Type[]): ts.Type | null => sharedJoinOfWrites(checker, types)

  /**
   * `declaration`'s own resolved type -- the join of every write to its
   * symbol -- or `null` when this module refuses it. Memoized in `bound`;
   * cycle-guarded by `resolvingDeclarations` so a cell whose write reads
   * itself (or another cell whose write reads this one) refuses instead of
   * looping.
   */
  const resolveDeclaration = (declaration: ts.VariableDeclaration): ts.Type | null => {
    const already = bound.get(declaration)
    if (already) return already
    const synthesized = unionTypeOf(unionArms.get(declaration) ?? null)
    if (synthesized) return synthesized
    if (!isCandidate(checker, declaration, flow)) return null
    if (refusalOf.has(declaration)) return null
    if (resolvingDeclarations.has(declaration)) return null
    resolvingDeclarations.add(declaration)
    const symbol = checker.getSymbolAtLocation(declaration.name)
    let result: ts.Type | null = null
    if (!symbol) {
      attribute(declaration, 'no-symbol')
    } else {
      // The initializer is a WRITE, and the first one. It is joined with every
      // later assignment rather than answering alone, so a cell that starts
      // `null` and is filled in later carries what it actually holds -- and
      // two writes that do not agree refuse the cell instead of picking one.
      const writes = identifierWritesOf(symbol)
      if (writes.length === 0) {
        // No assignment anywhere -- the ordinary "nothing ever writes it"
        // refusal, UNLESS this declaration is itself a `for (const x of xs)`
        // or `for (const x in obj)` loop's own binding, in which case the
        // loop head (never an assignment syntactically, but the value the
        // cell holds every iteration) is the one remaining source (row 22).
        // See `forOfElementType`/`forInElementType`.
        const viaForOf = forOfElementType(declaration) ?? forInElementType(declaration)
        if (viaForOf) result = viaForOf
        else attribute(declaration, noEvidenceReason(symbol, declaration))
      } else {
        // A synthesized union from the prior composed round is a proved
        // summary of THIS declaration's same write set, not a competing
        // authority. Seed the new join with its flattened arms so newly
        // resolved writes can widen it while temporarily silent recursive
        // writes cannot erase it. Without this feedback edge, a self-updating
        // cell alternated between its initial type and the union discovered
        // from its method-call assignments (`find-my-way`'s `currentNode`).
        // The transfer is now inflationary over the census's own arm lattice:
        // syntax contributes new evidence; no round retracts proven evidence.
        const priorArms = parameters.unionArmsAt(declaration) ?? prior.unionArmsAt(declaration)
        const types: ts.Type[] = priorArms ? priorArms.flatMap((type) => (type.isUnion() ? type.types : [type])) : []
        let silent = 0
        let refused: string | null = null
        for (const write of writes) {
          // A loop-head pattern write already carries its own resolved type
          // (`identifierWritesOf`'s `resolvedType`) -- there is no backing
          // expression for `known`/`resolveExpr` to re-type, since the value
          // comes from the loop's own iteration rather than any expression
          // the program wrote.
          const declared = write.resolvedType ?? known(write.node)
          // Settled synthesized source arms outrank a fresh derivation from
          // narrower caller/write samples, just as upstream typeAt does.
          const sourceArms = declared ? null : unionArmsForResolution(write.node)
          const type = declared ?? (sourceArms ? null : resolveExpr(write.node))
          const arms = sourceArms ?? (type ? null : branchArmsOf(write.node))
          // A checker union and a census arm list describe the same possible
          // writes. Join their constituents uniformly from the first round;
          // flattening only carried arms can alternate the publication between
          // typeAt and unionArmsAt on every outer inference round.
          if (type) types.push(...(type.isUnion() ? type.types : [type]))
          // A synthesized return has no checker ts.Type, but its complete
          // member list is still evidence for the cell receiving it. Dropping
          // that channel makes a native call result flow into an any cell.
          else if (arms) types.push(...arms.flatMap((arm) => (arm.isUnion() ? arm.types : [arm])))
          // A write typed `void`/`never` is a real fact stating the storage
          // holds nothing a program can use -- a veto in both phases, exactly
          // as `parameter-bindings.ts` keeps `call-passes-no-argument` firing
          // in its own relaxed phase. Only a write nobody could type is
          // SILENCE.
          else if (statesNoStorage(write.node)) {
            refused = 'write-states-no-storage'
            break
          } else silent += 1
        }
        // EVIDENCE EXHAUSTED -- the same rule, the same order, as
        // `parameter-bindings.ts`'s `skipSilentSites` phase and
        // `field-bindings.ts`'s twin of this loop: a write that states
        // nothing is not a write that disagrees. Strict phase first (a silent
        // write refuses the cell); the relaxed retry, run only over cells the
        // strict pass could not bind, joins the writes that DO speak.
        // `writes-disagree` still fires over what remains, and a cell whose
        // every write is silent still asks `declaredReturnEvidenceFor` and
        // then refuses, exactly as before.
        if (refused) attribute(declaration, refused)
        else if (silent > 0 && (!lenientPhase || types.length === 0)) {
          // Some write failed the ordinary route -- try the one remaining
          // authority before giving up: the enclosing function's own STATED
          // return type, when this cell is what its `return` is built from
          // (a program statement, which outranks a join over a write
          // SUBSET, so it keeps answering ahead of the relaxed retry). See
          // `declaredReturnEvidenceFor`'s header.
          const viaReturn = declaredReturnEvidenceFor(checker, declaration, symbol)
          if (viaReturn) {
            result = viaReturn
            // Publish the same answer at each SILENT write, not just at the
            // declaration. `bound` (below) is keyed by the declaration alone,
            // so a query landing on the write expression itself -- a call
            // producer asking a `CallExpression` for its OWN result type,
            // rather than something asking what the cell it feeds holds --
            // used to retry `compute` from scratch and hit the identical
            // wall that made the write silent to begin with: the checker's
            // resolved signature return is `any` for a reason internal to
            // the callee's own declaration (an erased generic default),
            // which does not become less `any` on a second look. That
            // divergence is exactly this module's header case, hono's own
            // `res = matchResult[0][0][0][0](c, next)` inside `#dispatch` --
            // `res`'s cell got the right answer FROM this return-evidence
            // fallback, but the call expression that fed it never did,
            // because nothing here fed it back. A cell and the expression
            // that writes it are one fact, and both readers of that fact
            // must agree, the same "two authorities" shape this compiler
            // refuses everywhere else. Every write that reached this branch
            // as silent was already run through `resolveExpr` (the `type`
            // computed above came from `known(write) ?? resolveExpr(write)`,
            // and `known` cannot have supplied a non-null `type` for a
            // silent write by construction), so `nodeMemo` already holds a
            // settled `null` for it -- never `undefined` (unresolved) and
            // never a cycle-guard bail (which leaves no entry). Recorded into
            // `writeAnswers`, not `nodeMemo` -- see that map's own comment
            // for why overwriting the settled `null` in place does not
            // survive: measured directly, it does not.
            for (const write of writes) {
              if (nodeMemo.get(write.node) === null) writeAnswers.set(write.node, viaReturn)
            }
          } else {
            // The single largest refusal reason on the three.js app (2087, 39% of all
            // binding refusals) and a pure CASCADE: every one of these cells
            // is refused because some write it holds is itself unresolved, so
            // ranking the cells says nothing about where to work. This prints
            // the unresolved WRITES instead, which is the set that has roots.
            if (process.env['GEA_LOCAL_DEBUG']) {
              for (const write of writes) {
                if (nodeMemo.get(write.node) !== null) continue
                const file = write.node.getSourceFile()
                const line = file.getLineAndCharacterOfPosition(write.node.getStart()).line + 1
                const where = `${file.fileName.split('/').slice(-2).join('/')}:${line}`
                process.stderr.write(
                  `[LOCAL] ${ts.SyntaxKind[write.node.kind]} ${where} ${write.node.getText().slice(0, 60).replace(/\s+/g, ' ')}\n`
                )
              }
            }
            attribute(declaration, 'write-unresolved')
          }
        } else if (silent > 0 && types.every((type) => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0)) {
          // AN ABSENCE IS NOT EVIDENCE.
          //
          // The relaxed phase above joins the writes that DO speak, and that
          // is right whenever one of them states a type. It is not right when
          // every surviving write is `null`/`undefined` and some other write
          // was silent: `null` says what the cell holds when nothing else has
          // been stored in it, never what it holds. `WebXRManager.js`'s
          // `let session = null` is written from `setSession( value )` too,
          // and binding the cell to bare `null` on the strength of the
          // initializer alone made every `session.removeEventListener(...)` a
          // property access on `null` -- 69 unmet obligations on the three.js app, and
          // underneath them a store-side silent miscompile: the emitted cell
          // would hold a null pointer that the real write has no
          // representation to fill. 76 locals program-wide were bound this
          // way. The same rule `parameter-bindings.ts` applies to a defaulted
          // parameter (a default value is not a type) and `field-bindings.ts`
          // to a field initialized `null`.
          //
          // Refusing leaves the cell exactly as dynamic as its unresolved
          // write makes it -- honest, and the boxing this costs closes when
          // that write's own type is recovered.
          attribute(declaration, 'writes-state-only-absence')
        } else {
          // Keep a carried synthesized union in its canonical arm channel.
          // Feeding its arms through `joinOfWrites` can materialize one
          // checker union and move the same fact into `typeAt`; the following
          // round then has no carried arms, reconstructs them, and alternates
          // forever between two representations of one answer. Flatten first
          // so a previously nullable arm and a duplicate newly-resolved write
          // compare as their actual constituents.
          const carried = priorArms
            ? disjointUnionMembersOf(
                checker,
                types.flatMap((type) => (type.isUnion() ? type.types : [type]))
              )
            : null
          if (carried) unionArms.set(declaration, carried)
          else {
            const widest = joinOfWrites(types)
            if (widest) {
              result = widest
            } else {
              // The join found no single covering type. Before refusing, ask
              // whether the disagreement is itself a sound answer -- see
              // `disjointUnionMembersOf`'s own comment for what "sound" means.
              const arms = disjointUnionMembersOf(checker, types)
              if (arms) unionArms.set(declaration, arms)
              else attribute(declaration, 'writes-disagree')
            }
          }
        }
      }
    }
    resolvingDeclarations.delete(declaration)
    if (result) bound.set(declaration, result)
    return result
  }

  const unwrapParens = (node: ts.Expression): ts.Expression => {
    let current: ts.Expression = node
    while (ts.isParenthesizedExpression(current)) current = current.expression
    return current
  }

  /** `known(node) ?? resolveExpr(node)`, except at an `as`/`<T>` cast: the checker's own answer there is taken as-is and never read past. */
  const knownOrResolve = (node: ts.Expression): ts.Type | null => {
    const unwrapped = unwrapParens(node)
    if (ts.isAsExpression(unwrapped) || ts.isTypeAssertionExpression(unwrapped)) return known(unwrapped)
    return known(node) ?? resolveExpr(node)
  }

  /**
   * ONE recursive notion of the storage a binding PATTERN reaches into,
   * covering rows 14 (object destructuring), 15 (array destructuring), 16
   * (destructuring defaults) and the destructured half of row 22 (for-of)
   * together, rather than as separate arms per pattern shape. A binding
   * pattern is a TREE of references (`bind(reference, value)`'s
   * `reference` half, ADDENDUM 3's own vocabulary): an object pattern's
   * MEMBERS and an array pattern's ELEMENTS are the language's only two leaf
   * shapes, so the branch inside `resolveBindingElement` below is the
   * recursion's BASE CASE run once, not a syntax special case per pattern
   * kind -- and it runs identically at any nesting depth, because a NESTED
   * pattern's own source is just the outer element's own resolved type
   * (`sourceTypeOfPattern`'s `ts.isBindingElement(parent)` arm), so depth is
   * free and no depth-specific code exists.
   *
   * `boundElements`/`elementRefusalOf`/`resolvingElements` mirror
   * `bound`/`refusalOf`/`resolvingDeclarations` above -- the identical
   * memo/refusal/cycle-guard shape, keyed by `ts.BindingElement` instead of
   * `ts.VariableDeclaration`, because a pattern leaf is a different node
   * kind from a plain declaration and cannot share the same map key.
   */
  const boundElements = new Map<ts.BindingElement, ts.Type>()
  const elementRefusalOf = new Map<ts.BindingElement, string>()
  const resolvingElements = new Set<ts.BindingElement>()

  /**
   * The iterable expression of a `for (const <name> of <expr>)` loop, when
   * `declaration` is that loop's own binding -- shared by the plain-
   * identifier case (`forOfElementType`, row 22) and the destructured-
   * binding case (`patternSourceExpression`), so both ask the identical "is
   * this a for-of binding" question once rather than twice. `for await` is
   * refused outright: it iterates a DIFFERENT protocol (the async-iterable
   * PROMISE each step resolves), not the plain element this reads.
   */
  const forOfIterableOf = (declaration: ts.VariableDeclaration): ts.Expression | null => {
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list)) return null
    const stmt = list.parent
    if (!ts.isForOfStatement(stmt) || stmt.initializer !== list || stmt.awaitModifier) return null
    return stmt.expression
  }

  /**
   * The element type a `for (const x of xs)` binding receives -- `xs`'s own
   * numeric index signature, the identical checker query `indexedTypeOf`
   * already runs for an ordinary `a[i]` read elsewhere in this module, with
   * the same array-census fallback (`collections.arrayElementForRead`) an
   * ordinary element READ already falls back to when the receiver's own
   * index signature is unusable (`never[]`, most often, from a push-only
   * cell). Not a special case: any indexable iterable answers here, nothing
   * keyed to a particular library or container name.
   */
  const forOfElementType = (declaration: ts.VariableDeclaration): ts.Type | null => {
    const expression = forOfIterableOf(declaration)
    if (!expression) return null
    const iterable = knownOrResolve(expression)
    if (!iterable) return null
    const nonNull = checker.getNonNullableType(iterable)
    const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
    if (indexed && !isUnusableEvidence(indexed)) return indexed
    return collections.arrayElementForRead(expression)
  }

  /**
   * The element type a `for (const key in obj)` binding receives.
   *
   * `ForIn/OfHeadEvaluation` (ECMA-262 13.7.5.6, the `enumerate` case)
   * enumerates OWN-plus-INHERITED enumerable keys and coerces every one to a
   * STRING before the loop body ever sees it -- never a symbol, never the
   * object's own element type -- so the answer is `string` unconditionally,
   * the same checker type `forOfBareIdentifierElementTypeAt` already returns
   * a few lines up for the bare-identifier-reused shape of this same loop
   * (`var k; for (k in obj) ...`). This is `forOfElementType`'s DECLARED-in-
   * loop counterpart for `for...in`: without it, `for (const key in obj) ...`
   * with a `key` the body only ever READS found no evidence at all and
   * refused as `no-writes:existence-only:iteration-binding` -- the loop's own
   * binding is exactly as real a value as a for-of element is, just one this
   * module never asked the language's own (fixed, unconditional) answer for.
   */
  const forInElementType = (declaration: ts.VariableDeclaration): ts.Type | null => {
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list)) return null
    const stmt = list.parent
    if (!ts.isForInStatement(stmt) || stmt.initializer !== list) return null
    return checker.getStringType()
  }

  /**
   * The element type a for-of/for-in loop's own BARE-IDENTIFIER head receives,
   * when that identifier is declared OUTSIDE the loop and reused as a plain
   * assignment target -- `var v; for (v of xs) ...` -- rather than declared
   * by the loop itself. `flow/value-flow.ts`'s `visit` records this write via
   * `recordAssignmentTarget(initializer, 'iteration-binding', null, node)`,
   * whose `naming` is the loop head's own identifier EXPRESSION -- a
   * different node from `forOfElementType`'s `declaration`, and one whose
   * `.parent` IS the ForOfStatement/ForInStatement directly (unlike a
   * declared-in-loop binding, whose name is parented under its own
   * `VariableDeclaration`, and unlike a literal pattern head, walked instead
   * by `forOfPatternElementTypeAt`). `identifierWritesOf` had no case for a
   * bare `'iteration-binding'` write at all, so a cell filled ONLY this way
   * found no evidence and boxed even though `xs` itself is a native array --
   * `forOfElementType`'s own logic, asked at the WRITE's loop statement
   * instead of at a declaration's syntactic position, since a `var v`
   * declared elsewhere is never itself parented under the for-of/for-in.
   */
  const forOfBareIdentifierElementTypeAt = (naming: ts.Expression): ts.Type | null => {
    const parent = naming.parent
    if (ts.isForOfStatement(parent) && parent.initializer === naming) {
      if (parent.awaitModifier) return null
      const iterable = knownOrResolve(parent.expression)
      if (!iterable) return null
      const nonNull = checker.getNonNullableType(iterable)
      const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
      if (indexed && !isUnusableEvidence(indexed)) return indexed
      return collections.arrayElementForRead(parent.expression)
    }
    if (ts.isForInStatement(parent) && parent.initializer === naming) return checker.getStringType()
    return null
  }

  type PatternPositionStep = { readonly kind: 'array'; readonly position: number } | { readonly kind: 'object'; readonly key: string }

  /**
   * Walks a destructuring-ASSIGNMENT target up through any nested array/
   * object literal patterns to the pattern's own ROOT, recording the
   * (position|key) step at each level -- the census-side twin of
   * `producers/destructuring.ts`'s `arrayAssignmentBoundTypeOf` recursion,
   * needed here because a for-of/for-in LOOP-HEAD pattern's per-position
   * value has no literal source expression
   * `destructuringAssignmentEvidenceExpressionAt` can index into: it comes
   * from the loop's own iteration, never from an expression the program
   * wrote. Steps are ordered OUTERMOST first, the order they must be applied
   * in to the loop's own per-iteration type.
   */
  const assignmentPatternStepsAt = (
    target: ts.Expression
  ): { readonly root: ts.Expression; readonly steps: readonly PatternPositionStep[] } | null => {
    const steps: PatternPositionStep[] = []
    let current: ts.Expression = target
    for (;;) {
      const arrayTarget = arrayAssignmentTargetOf(current)
      if (arrayTarget) {
        steps.unshift({ kind: 'array', position: arrayTarget.position })
        current = arrayTarget.pattern
        continue
      }
      const objectElement = objectAssignmentElementOfTarget(current)
      if (objectElement) {
        const pattern = objectElement.parent
        if (!ts.isObjectLiteralExpression(pattern)) return null
        const keyName = ts.isShorthandPropertyAssignment(objectElement) ? objectElement.name.text : staticPropertyName(objectElement.name)
        if (keyName === null) return null
        steps.unshift({ kind: 'object', key: keyName })
        current = pattern
        continue
      }
      break
    }
    return steps.length > 0 ? { root: current, steps } : null
  }

  /**
   * The per-position/per-key type an array/object LITERAL for-of/for-in
   * loop-head pattern's element receives every iteration -- the assignment
   * twin of `resolveBindingElement`'s indexed/tuple read, over the loop's
   * own per-iteration value (a for-of's iterable element, a for-in's key
   * STRING) rather than a `const`/`let` declaration's initializer: `var
   * pairs = [[1, 2]]; var a, b; for ([a, b] of pairs)` never writes `a`/`b`
   * from any right-hand side, only from the loop head itself.
   */
  const forOfPatternElementTypeAt = (naming: ts.Expression): ts.Type | null => {
    const located = assignmentPatternStepsAt(naming)
    if (!located) return null
    const parent = located.root.parent
    let elementType: ts.Type | null
    if (ts.isForOfStatement(parent) && parent.initializer === located.root) {
      const iterable = knownOrResolve(parent.expression)
      if (!iterable) return null
      const nonNull = checker.getNonNullableType(iterable)
      const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
      elementType = indexed && !isUnusableEvidence(indexed) ? indexed : collections.arrayElementForRead(parent.expression)
    } else if (ts.isForInStatement(parent) && parent.initializer === located.root) {
      elementType = checker.getStringType()
    } else {
      return null
    }
    if (!elementType) return null
    for (const step of located.steps) {
      if (step.kind === 'object') {
        const propType = propertyTypeOf(elementType, step.key, naming)
        if (!propType) return null
        elementType = propType
        continue
      }
      const nonNull = checker.getNonNullableType(elementType)
      if (checker.isTupleType(nonNull)) {
        const stated = checker.getTypeArguments(nonNull as ts.TupleTypeReference)[step.position]
        elementType = stated === undefined ? checker.getUndefinedType() : checker.getBaseTypeOfLiteralType(stated)
        continue
      }
      const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
      if (!indexed || isUnusableEvidence(indexed)) return null
      elementType = indexed
    }
    return elementType
  }

  /** The actual SOURCE expression a top-level (non-nested) pattern reads from, when one syntactically exists -- used only for the array-census fallback below; the recursive nested case has no single expression of its own (its source IS another element's resolved type) and does not need one. */
  const patternSourceExpression = (pattern: ts.BindingPattern): ts.Expression | null => {
    const parent = pattern.parent
    if (!ts.isVariableDeclaration(parent)) return null
    return parent.initializer ?? forOfIterableOf(parent)
  }

  /**
   * The value flowing INTO a whole binding pattern -- the source half of the
   * `bind(reference, value)` primitive, asked at the pattern's own root
   * rather than at one leaf. Three roots, each already a question this
   * module (or a sibling one) asks for an ordinary identifier, never a new
   * one invented for destructuring:
   *  - `const {a} = expr` / `let [a] = expr` -- the declaration's own
   *    initializer, read the same way any other initializer is
   *    (`knownOrResolve`).
   *  - `for (const {a} of xs)` -- `xs`'s own element type
   *    (`forOfElementType`), the identical question a for-of loop over a
   *    PLAIN identifier already answers.
   *  - a NESTED pattern (`const {a: {b}} = expr`) -- the outer element's own
   *    resolved type (`resolveBindingElement`), so nesting recurses for
   *    free.
   * A parameter's own pattern (`function f({a}) {}`) is PAR's cell, not this
   * module's: neither branch below matches a `ParameterDeclaration` parent,
   * so it falls through to `null` -- refusing exactly as everywhere else
   * this module does not own a cell.
   */
  const sourceTypeOfPattern = (pattern: ts.BindingPattern): ts.Type | null => {
    const parent = pattern.parent
    if (ts.isVariableDeclaration(parent)) {
      // `= {}` is a holder, not a non-statement -- see `exactEmptyObjectLiteralType`.
      if (parent.initializer) return exactEmptyObjectLiteralType(checker, parent.initializer) ?? knownOrResolve(parent.initializer)
      return forOfElementType(parent)
    }
    if (ts.isBindingElement(parent)) return resolveBindingElement(parent)
    // A parameter's own pattern reads the slot the PARAMETER census bound
    // from the call sites (`parameter-bindings.ts`'s `isUnannotated` admits
    // a destructured parameter); that census also answers the leaves itself,
    // so this arm only matters for a leaf it declined and this module can
    // still finish (a default joined onto a resolved element, say).
    if (ts.isParameter(parent)) return parameters.typeAt(parent)
    return null
  }

  /**
   * The source CELL type for object-rest layout. Unlike a named property read,
   * rest copies the runtime object's remaining key set, so a predicate's closed
   * control-flow view cannot erase an index signature owned by the cited cell.
   */
  const storageSourceTypeOfPattern = (pattern: ts.BindingPattern): ts.Type | null => {
    const parent = pattern.parent
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer) return resolveExpr(parent.initializer) ?? knownOrResolve(parent.initializer)
      return forOfElementType(parent)
    }
    if (ts.isBindingElement(parent)) return resolveBindingElement(parent)
    return null
  }

  /**
   * `element`'s own resolved type -- the ONE recursive function answering
   * every binding-pattern leaf, object or array, nested or not, defaulted or
   * not. Object and array are the language's only two pattern shapes, so the
   * branch below is the recursion's BASE CASE, not a special-cased arm per
   * pattern kind; a default value is joined in exactly once, after the
   * branch, for whichever shape produced `ownType` -- also not a third case,
   * since every leaf (object or array) can carry one.
   *
   * A computed property name (`{[k]: v}`) names no FIXED member -- `key` is
   * then not an identifier and `ownType` stays `null`, refused the same way
   * an unresolved member read anywhere else in this module refuses.
   *
   * `ownType` (the source-derived projection) must resolve successfully
   * BEFORE a default is ever considered -- a default's type is never used as
   * sole evidence, because an untyped source could hold anything at
   * runtime, not only the default's type. `joinOfWrites` (not plain
   * `widestOf`) combines `ownType` with a default's type because it already
   * safely handles the "nullish is absence" idiom a defaulted destructure
   * commonly is (`const {a = 1} = o` reads exactly as `a` being `T |
   * undefined` with the `undefined` arm's own default value).
   */
  const resolveBindingElement = (element: ts.BindingElement): ts.Type | null => {
    const already = boundElements.get(element)
    if (already) return already
    if (elementRefusalOf.has(element)) return null
    if (resolvingElements.has(element)) return null
    resolvingElements.add(element)
    const pattern = element.parent
    if (element.dotDotDotToken) {
      const sourceType = ts.isObjectBindingPattern(pattern) ? storageSourceTypeOfPattern(pattern) : null
      const nonNull = sourceType ? checker.getNonNullableType(sourceType) : null
      const stringIndex = nonNull ? checker.getIndexTypeOfType(nonNull, ts.IndexKind.String) : undefined
      const result = sourceType && stringIndex && checker.getPropertiesOfType(nonNull as ts.Type).length === 0 ? sourceType : null
      resolvingElements.delete(element)
      if (result) boundElements.set(element, result)
      else elementRefusalOf.set(element, sourceType ? 'rest-source-not-open-dictionary' : 'source-unresolved')
      return result
    }
    const sourceType = sourceTypeOfPattern(pattern)
    let ownType: ts.Type | null = null
    if (sourceType) {
      if (ts.isObjectBindingPattern(pattern)) {
        const key = element.propertyName ?? element.name
        const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : null
        const nonNull = checker.getNonNullableType(sourceType)
        const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
        // A numeric key over a plain array reads the element WITH `undefined`
        // (`[...{ 3: y }] = [7, 8, 9]`); the parameter census's
        // `arrayIndexPatternReadOf` is the same rule for a formal's pattern.
        const arrayIndexRead =
          keyText !== null &&
          /^(0|[1-9][0-9]*)$/.test(keyText) &&
          indexed &&
          !isUnusableEvidence(indexed) &&
          !checker.isTupleType(nonNull) &&
          !checker.getIndexTypeOfType(nonNull, ts.IndexKind.String)
            ? checker.getNullableType(indexed, ts.TypeFlags.Undefined)
            : null
        // A key the holder's closed object type declares no member for reads
        // `undefined` (`const { fn = function () {} } = {}` binds the default);
        // the parameter census's `absentKeyPatternReadOf` is the same rule and
        // states why an index signature or a union keeps the member read.
        const absentRead =
          keyText !== null &&
          arrayIndexRead === null &&
          !isUnusableEvidence(nonNull) &&
          (nonNull.flags & ts.TypeFlags.Object) !== 0 &&
          !checker.getPropertyOfType(nonNull, keyText) &&
          !indexed &&
          !checker.getIndexTypeOfType(nonNull, ts.IndexKind.String)
            ? checker.getUndefinedType()
            : null
        ownType = arrayIndexRead ?? absentRead ?? (keyText !== null ? propertyTypeOf(sourceType, keyText, element) : null)
      } else {
        const nonNull = checker.getNonNullableType(sourceType)
        const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
        // A plain array's element is read WITH `undefined`: the pattern may run
        // past the array's length, and the language binds the name to
        // `undefined` there (ECMA-262 IteratorBindingInitialization) rather
        // than faulting. A tuple states its length, so its position answers
        // bare -- `checker.isTupleType` is that distinction.
        const withAbsence = (element: ts.Type): ts.Type =>
          checker.isTupleType(nonNull) ? element : checker.getNullableType(element, ts.TypeFlags.Undefined)
        if (indexed && !isUnusableEvidence(indexed)) {
          ownType = withAbsence(indexed)
        } else {
          const expr = patternSourceExpression(pattern)
          const censused = expr ? collections.arrayElementForRead(expr) : null
          // A non-array iterable (`var [a, b] = g()` over a generator, a Set,
          // a Map) has no numeric index to read; what a position holds is
          // what the source YIELDS -- and always with `undefined`, since a
          // cursor can be exhausted before any position (the checker types
          // the binding bare, which read `0` for a missing second value).
          const yielded = censused ? null : iteratorYieldTypesOf(checker, nonNull, pattern)
          ownType = censused ? withAbsence(censused) : yielded?.length === 1 && yielded[0] ? withAbsence(yielded[0]) : null
        }
      }
    }
    let result: ts.Type | null = null
    if (ownType) {
      if (element.initializer) {
        // The name holds the read with its absence replaced by the default;
        // `var [a, b = 5] = arr` binds `b` a number, not `number | undefined`.
        const defaultType = knownOrResolve(element.initializer)
        // A read that is NOTHING BUT the absence (an absent key over a closed
        // holder) binds the default alone: `withoutUndefinedMember` has no
        // member to keep there, and joining it would put the absence back.
        const absentOnly = !ownType.isUnion() && (ownType.flags & ts.TypeFlags.Undefined) !== 0
        result = defaultType
          ? absentOnly
            ? defaultType
            : (joinOfWrites([withoutUndefinedMember(checker, ownType), defaultType]) ?? ownType)
          : ownType
      } else {
        result = ownType
      }
    }
    resolvingElements.delete(element)
    if (result) boundElements.set(element, result)
    else elementRefusalOf.set(element, sourceType ? 'element-unresolved' : 'source-unresolved')
    return result
  }

  /**
   * The general walk, one node at a time: an identifier defers to the
   * upstream (parameter+return) census first, and only falls to this
   * module's own write-set resolution where that authority has nothing --
   * which is exactly the cell-with-no-initializer gap this module exists
   * for. Every other node kind recurses through the SAME upstream-first rule
   * at its own operands, so a chain like `state.buffers` resolves once
   * `state` does, regardless of which layer actually answered `state`.
   */
  /**
   * What `this` holds at a keyword: the checker's answer, except inside a
   * function written as an object literal's property (`{ valueOf: function
   * () { thisValue = this } }`), where the checker answers `any` for a JS
   * file and the literal is the only object that function is ever entered
   * with -- the same reading `structural-receiver.ts` gives the function's
   * receiver. An arrow between the keyword and that function is walked
   * through, as the language does.
   */
  const thisValueTypeOf = (keyword: ts.Node): ts.Type | null => {
    let scope: ts.Node | undefined = keyword.parent
    while (scope && (ts.isArrowFunction(scope) || !(ts.isFunctionLike(scope) || ts.isClassLike(scope) || ts.isSourceFile(scope)))) {
      scope = scope.parent
    }
    if (scope && (ts.isFunctionExpression(scope) || ts.isMethodDeclaration(scope))) {
      const owner = ts.isPropertyAssignment(scope.parent) ? scope.parent.parent : scope.parent
      if (ts.isObjectLiteralExpression(owner)) return contextTypedLiteralThisOf(checker, owner, keyword) ?? checker.getTypeAtLocation(owner)
    }
    return checker.getTypeAtLocation(keyword)
  }

  const compute = (node: ts.Node): ts.Type | null => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return knownOrResolve(node.expression)
    }
    if (ts.isVariableDeclaration(node)) return resolveDeclaration(node)
    // `thisValue = this` inside an object literal's method: the checker
    // types the keyword as the literal (a class's method as the instance),
    // and that is as much a write of a record as `t = o` is. A `this` the
    // checker cannot place -- a plain function's, `any` -- states nothing.
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const type = thisValueTypeOf(node)
      return type === null || isUnusableEvidence(type) || (type.flags & ts.TypeFlags.Unknown) !== 0 ? null : type
    }
    if (ts.isIdentifier(node)) {
      const upstream = parameters.typeAt(node)
      if (upstream) return upstream
      const synthesized = unionTypeOf(parameters.unionArmsAt(node))
      if (synthesized) return synthesized
      const declaration = declarationOf(node)
      if (declaration) return resolveDeclaration(declaration)
      const element = bindingElementDeclarationOf(node)
      return element ? resolveBindingElement(element) : null
    }
    if (ts.isPropertyAccessExpression(node)) {
      const upstream = parameters.typeAt(node)
      if (upstream) return upstream
      const unionMember = unionArmsForResolution(node.expression)
      if (unionMember) {
        const projected = unionMemberTypeOf(unionMember, node.name.text, node)
        if (projected) return projected
      }
      const receiver = knownOrResolve(node.expression)
      // The bag census before the receiver's own type AND after it, because a
      // `{}` receiver IS resolvable -- the checker types it as the empty
      // object -- so `propertyTypeOf` answers `null` for every slot rather
      // than failing to find a receiver. See `slotTypeAt`.
      if (!receiver) return bags.slotTypeAt(node)
      return propertyTypeOf(receiver, node.name.text, node) ?? bags.slotTypeAt(node)
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const upstream = parameters.typeAt(node)
      if (upstream) return upstream
      const receiver = knownOrResolve(node.expression)
      if (!receiver) return collections.arrayElementForRead(node.expression) ?? bags.slotTypeAt(node)
      // A literal key is a named member spelled with brackets; any other key
      // is answered by the receiver's index signature, and by nothing else.
      const name = literalMemberNameOf(node)
      if (name !== null) return propertyTypeOf(receiver, name, node) ?? bags.slotTypeAt(node)
      const key = knownOrResolve(node.argumentExpression)
      if (!key) return bags.slotTypeAt(node)
      // See `return-bindings.ts`'s identical fallback: a resolved receiver
      // with no index signature of its own (`never[]`, most often) is still
      // answerable from the array census's own push/write evidence -- and a
      // `{}` bag's index half from this census's own write evidence.
      return (
        indexedTypeOf(checker, receiver, key, node, flow, parameters) ??
        collections.arrayElementForRead(node.expression) ??
        bags.slotTypeAt(node)
      )
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const upstream = parameters.typeAt(node)
      if (upstream) return upstream
      const invariant = overloadInvariantReturnTypeAt(checker, node, knownOrResolve)
      if (invariant) return invariant
      const callee = knownOrResolve(node.expression)
      if (!callee) return keyedCollectionRead(node)
      const constructed = ts.isNewExpression(node) ? callee.getConstructSignatures() : []
      const signatures = constructed.length > 0 ? constructed : callee.getCallSignatures()
      if (signatures.length !== 1) return keyedCollectionRead(node)
      const signature = signatures[0] as ts.Signature
      const unwrapped = ts.isCallExpression(node) ? unwrapExplicitThisCall(checker, node) : null
      const returned = explicitThisCallReturnType(signature, unwrapped ? knownOrResolve(unwrapped.callee) : null)
      if ((returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return null
      // `any` is not the only way a callee can state nothing about what it
      // returns, and a structurally EMPTY object type is the other way --
      // which is the answer the checker gives for a factory that builds a bag
      // through a dynamic key. `fetchAttributeLocations` (WebGLProgram.js)
      // opens `const attributes = {}`, fills `attributes[ name ] = { type,
      // location, locationSize }` and returns it; the checker's inferred
      // return type is `{}`, and taking that at face value bound the cell to
      // a record with no fields. That is worse than refusing: this census is
      // the FIRST half of the composed view, so its `{}` shadowed the bag
      // census's own real answer for the same node, and every
      // `programAttributes[ name ]` behind it stayed dynamic -- 64 boxes on
      // one read in `WebGLBindingStates.js` alone. Refusing lets the bag
      // census answer, which is the deferral `keyedCollectionRead` below
      // already makes for a container.
      if (!isAnyType(returned) && !isEmptyObjectType(returned)) return returned
      return keyedCollectionRead(node)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return knownOrResolve(node.right)
    if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      return derivedExpressionType(checker, node, (operand) => knownOrResolve(operand))
    }
    return null
  }

  /**
   * The value a `container.get( k )` yields, when the CONTAINER's own census
   * knows it and the checker does not.
   *
   * `new WeakMap()` written with no type arguments is `WeakMap<object, any>`,
   * so `get`'s declared return is `any` and the call states nothing -- while
   * `collection-bindings.ts` has already inferred V from the program's own
   * `set` calls. That census is the authority for what a container holds,
   * exactly as `arrayElementForRead` is for an array's elements two arms
   * below, and asking it is the same deferral rather than a new inference.
   *
   * `V | undefined`, never bare `V`: `Map`/`WeakMap` `get` answers `undefined`
   * for an absent key, and three's `WebGLProperties.get` tests exactly that
   * (`if ( map === undefined ) { map = {}; ... }`). Dropping the absence here
   * would hand the guard a cell that cannot hold the value it tests for.
   *
   * Without this, `let map = properties.get( object )` refused as
   * `write-unresolved`; that left `WebGLProperties.get`'s own return `any`,
   * and every `properties.get( material ).uniforms` in `WebGLRenderer.js` and
   * `WebGLMaterials.js` dynamic behind it.
   */
  const keyedCollectionRead = (node: ts.CallExpression | ts.NewExpression): ts.Type | null => {
    if (!ts.isCallExpression(node)) return null
    const target = node.expression
    if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'get') return null
    const argumentTypes = collections.typeArgumentsForRead(target.expression)
    const value = argumentTypes?.value
    if (!value || isUnusableEvidence(value)) return null
    return checker.getNullableType(value, ts.TypeFlags.Undefined)
  }

  const resolveExpr = (node: ts.Node): ts.Type | null => {
    // `writeAnswers` first, ahead of the ordinary memo: a write recorded
    // there was already resolved -- via the cell it feeds, not via `compute`
    // on this node -- and `nodeMemo` may hold a now-stale `null` for the
    // same node left over from before that resolution, or wiped since by the
    // lenient retry's own `clear()`. Either way this is the newer, better
    // answer and must win.
    const backfilled = writeAnswers.get(node)
    if (backfilled) return backfilled
    const cached = nodeMemo.get(node)
    if (cached !== undefined) return cached
    if (nodeResolving.has(node)) return null
    nodeResolving.add(node)
    const answer = compute(node)
    nodeResolving.delete(node)
    nodeMemo.set(node, answer)
    return answer
  }

  /** A refusal's `owner` for a `VariableDeclaration` candidate: the cell's own name and where the program wrote it. */
  const ownerOfDeclaration = (declaration: ts.VariableDeclaration): string => {
    const file = declaration.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1
    return `${declaration.name.getText()} (${file.fileName}:${line})`
  }

  /** The identical rendering for a binding-pattern leaf, whose own name is `element.name` rather than a `VariableDeclaration`'s. */
  const ownerOfElement = (element: ts.BindingElement): string => {
    const file = element.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(element.getStart()).line + 1
    return `${element.name.getText()} (${file.fileName}:${line})`
  }

  // Resolve every candidate up front, so `boundCount`/`refusals` reflect the
  // whole program rather than only the nodes some other pass happened to
  // query.
  const candidates: ts.VariableDeclaration[] = []
  const elementCandidates: ts.BindingElement[] = []
  /**
   * ⛔ The single largest `no-writes` bucket -- 127 of 127 measured on
   * the three.js app, every one of them `no-writes:initializer-unseen` -- was never a
   * write-index defect. It was THIS walk disagreeing with `flow`'s own about
   * what counts as live code.
   *
   * `indexValueFlow` (`flow/value-flow.ts`) checks `reachable.memberIsPruned`
   * on every node it descends into, so a method nothing calls (three's
   * `Node.prototype.analyze`, `PMREMGenerator.prototype._sceneToCubeUV`, the
   * entire `nodes/` TSL class family the app's WebGL renderer never reaches)
   * contributes zero writes -- correctly: dead code has no evidence to give.
   * This walk used to check only `forEachReachableStatement`'s TOP-LEVEL
   * filter and then recurse with a bare `ts.forEachChild`, never re-asking
   * `memberIsPruned` for a nested member the way `value-flow.ts` does. A
   * pruned method's locals were still gathered as CANDIDATES here, so
   * `resolveDeclaration` asked `flow.writesToSymbol` a question the index had
   * every right to answer "nothing" to, and reported that silence as if it
   * were a defect in the index rather than the correct absence of evidence
   * for code that never runs.
   *
   * Measured: every one of the three.js app's 127 `no-writes:initializer-unseen`
   * refusals sits inside a member `reachable.memberIsPruned` marks pruned
   * (`Quaternion.prototype.setFromUnitVectors`,
   * `PMREMGenerator.prototype._sceneToCubeUV`/`_halfBlur`, the whole `Node`/
   * `ContextNode`/`LightsNode`/`NodeMaterial` TSL base classes, and others);
   * none were reachable declarations the index dropped. Matching `flow`'s own
   * boundary here removes the false refusal instead of teaching
   * `noEvidenceReason` to explain evidence that was never going to exist.
   */
  const visit = (node: ts.Node): void => {
    if (reachable.memberIsPruned(node)) return
    if (ts.isVariableDeclaration(node)) {
      registerObservedIndexedAbsence(node)
      if (isCandidate(checker, node, flow)) candidates.push(node)
    }
    if (ts.isBindingElement(node) && isElementCandidate(checker, node)) elementCandidates.push(node)
    ts.forEachChild(node, visit)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visit)
  for (const candidate of candidates) resolveDeclaration(candidate)
  for (const element of elementCandidates) resolveBindingElement(element)
  // The relaxed phase, run only once the strict pass has settled -- so every
  // cell the strict rule can bind is bound from ALL its writes before any
  // cell is bound from a subset. Rounds repeat because a cell bound from
  // surviving evidence is itself evidence for another cell's writes; the
  // node memo is cleared each round because its cached nulls are answers to
  // the smaller view. Terminates because bindings are only ever added.
  lenientPhase = true
  for (;;) {
    const retry = candidates.filter((candidate) => !bound.has(candidate) && refusalOf.get(candidate) === 'write-unresolved')
    if (retry.length === 0) break
    for (const candidate of retry) refusalOf.delete(candidate)
    nodeMemo.clear()
    const before = bound.size
    for (const candidate of retry) resolveDeclaration(candidate)
    if (bound.size === before) break
  }

  // `root` is the same stable, hand-written reason string this census always
  // keyed its old count map by (`no-symbol`, `write-unresolved`, one of
  // `noEvidenceReason`'s `no-writes:...` family, ...) -- never node text or a
  // type spelling, so it is already the ROOT `census-refusal.ts` asks for.
  // `owner` is the new fact: the declaration's/leaf's own name and source
  // location, the one thing a count could never say.
  const refusals: CensusRefusal[] = []
  for (const candidate of candidates) {
    if (bound.has(candidate) || unionArms.has(candidate)) continue
    const root = refusalOf.get(candidate) ?? 'unresolved'
    refusals.push(censusRefusal('local', root, root, ownerOfDeclaration(candidate)))
  }
  for (const element of elementCandidates) {
    if (boundElements.has(element)) continue
    const root = elementRefusalOf.get(element) ?? 'element-unresolved'
    refusals.push(censusRefusal('local', root, root, ownerOfElement(element)))
  }
  return {
    bindingTypeAt: (node) => {
      // A checker narrowing belongs to the read; it does not replace the
      // storage contract. Only an untyped read takes the cell's full answer.
      if (ts.isIdentifier(node) && !isAnyType(checker.getTypeAtLocation(node))) return null
      const declaration = ts.isVariableDeclaration(node) ? node : ts.isIdentifier(node) ? declarationOf(node) : null
      return declaration ? (bound.get(declaration) ?? null) : null
    },
    typeAt: (node) => {
      if (ts.isVariableDeclaration(node)) return bound.get(node) ?? null
      if (ts.isBindingElement(node)) return boundElements.get(node) ?? null
      return resolveExpr(node)
    },
    preferredTypeAt: (node) => {
      const observedAbsence = observedIndexedAbsence.get(node)
      if (observedAbsence) return observedAbsence
      const element = ts.isBindingElement(node) ? node : ts.isIdentifier(node) ? bindingElementDeclarationOf(node) : null
      if (element?.dotDotDotToken && ts.isObjectBindingPattern(element.parent)) {
        const rest = boundElements.get(element)
        if (rest) return rest
      }
      const declaration = ts.isVariableDeclaration(node) ? node : ts.isIdentifier(node) ? declarationOf(node) : null
      if (!declaration?.initializer || !ts.isConditionalExpression(declaration.initializer)) return null
      const declarationList = declaration.parent
      if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) === 0) return null
      // A const cell has exactly its initializer's construction invariant; no
      // later assignment can invalidate this stronger view. The conditional
      // operation itself keeps the checker's wider union and the binding
      // conversion explicitly selects the proven array arm.
      return normalizedArrayConditionalType(checker, declaration.initializer, (operand) => checker.getTypeAtLocation(operand))
    },
    unionArmsAt: (node) => {
      // `instanceof` and `typeof` can narrow even a checker-any reference.
      // Keep that read's established type; the declaration still owns the
      // full storage union and the ordinary narrowing conversion connects it.
      if (ts.isIdentifier(node) && !isAnyType(checker.getTypeAtLocation(node))) return null
      return synthesizedUnionArmsAt(checker, node, unionArms, ts.isVariableDeclaration)
    },
    boundCount: bound.size + unionArms.size + boundElements.size,
    refusals,
    refusalOf: (declaration) => refusalOf.get(declaration) ?? null
  }
}

/**
 * A `ParameterBindingCensus`-shaped view answering from BOTH: `parameters`'s
 * own answer first, this census's otherwise -- the seam meant for
 * `frontend.ts`, composed exactly as `return-bindings.ts`'s own
 * `withReturnBindings` is: swap
 *
 *   const parameters = withReturnBindings(checker, files, censusParameterBindings(checker, files))
 *
 * for
 *
 *   const parameters = withLocalBindings(checker, files, withReturnBindings(checker, files, censusParameterBindings(checker, files)))
 *
 * and the rest of the pipeline (`createStructuralMapper` and everything past
 * it) is unchanged.
 */
export const withLocalBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus,
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  /** The whole-program value-flow index -- see `censusLocalBindings`'s own parameter. */
  flow: ValueFlowIndex,
  /** The same-round property-bag census -- see `censusLocalBindings`'s own parameter. */
  bags: ObjectBagCensus = emptyObjectBagCensus,
  /** The prior outer view carrying this domain's own arm facts. */
  prior: ParameterBindingCensus = emptyParameterBindingCensus,
  moduleRecords: CommonJsModuleRecordCensus = emptyCommonJsModuleRecordCensus
): ParameterBindingCensus => {
  const locals = censusLocalBindings(checker, files, reachable, parameters, collections, flow, bags, prior, moduleRecords)
  // `parameters.refusals` is already `ParameterBindingCensus`'s own
  // `readonly CensusRefusal[]` -- both lists are the SAME vocabulary
  // (`census-refusal.ts`), each entry self-namespaced by its own `key`
  // (`census:parameter:...`/`census:return:...` upstream,
  // `census:local:...` here), so composing is concatenation: nothing to
  // recount, nothing to prefix, and no refusal is dropped on the way through
  // this wrapper.
  const refusals: readonly CensusRefusal[] = [...parameters.refusals, ...locals.refusals]
  return {
    ...parameters,
    // The owning local census replaces a prior-round answer propagated by
    // parameter inference. Otherwise that stale answer shadows its own
    // corrected write-set join forever. Other expression answers preserve
    // the established upstream-first order.
    // A synthesized union remains owned by the arm channel. `censusLocalBindings`
    // materializes it only while resolving dependants; publishing that
    // internal bridge here as a second `typeAt` authority would make the
    // structural mapper choose between two spellings of the same carrier.
    typeAt: (node) =>
      locals.preferredTypeAt(node) ??
      locals.bindingTypeAt(node) ??
      (locals.unionArmsAt(node) ? null : (parameters.typeAt(node) ?? (parameters.unionArmsAt(node) ? null : locals.typeAt(node)))),
    preferredTypeAt: (node) => locals.preferredTypeAt(node) ?? parameters.preferredTypeAt?.(node) ?? null,
    unionArmsAt: (node) => locals.unionArmsAt(node) ?? parameters.unionArmsAt(node),
    boundCount: parameters.boundCount + locals.boundCount,
    refusals
  }
}
