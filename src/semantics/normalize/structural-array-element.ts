import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralShape } from '../model/structural-types.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { CollectionBindingCensus, CollectionTypeArguments } from './collection-bindings.js'
import { bagShapeTypeAt, type ObjectBagCensus } from './object-bag-bindings.js'

/**
 * `never[]` IS NOT A TYPE THE PROGRAM ASKED FOR.
 *
 * `this.children = []` and `state.probe = []` type as `never[]`, and TS's
 * evolving-array widening does not cross a function boundary -- so the nine
 * `Vector3`s `WebGLLights.js` pushes into `state.probe` one line later never
 * reach the cell's type, and every read of it derives a carrier for a value
 * that cannot exist. `collection-bindings.ts` already answers what the writes
 * actually produce; this is the one place its answer enters the type system.
 *
 * Wired here rather than in `typeOf` because the answer is keyed by NODE:
 * `typeOf` receives a `ts.Type`, and every `never[]` in the program is the
 * SAME checker type object regardless of which cell it came from. Only the
 * node says which array this is.
 *
 * `checker.createArrayType` is checker-internal, so there is no `T[]`
 * `ts.Type` to hand back -- and none is needed. This compiler's own `array`
 * shape is what the pipeline consumes, and interning it directly from the
 * element's structural id is both shorter and free of a synthesized checker
 * type nothing else would recognise.
 *
 * ⛔ This is NOT the reachability question. A `never` here is TypeScript's
 * mis-inference, not a proof of anything -- `state.probe[ i ].set( 0, 0, 0 )`
 * at `WebGLLights.js:216` is unconditional and runs every frame. Marking such
 * an operand unreachable was tried and miscompiled live code. Correcting the
 * ELEMENT TYPE is the opposite move: it gives that line the carrier it always
 * needed instead of declaring it dead.
 */
/**
 * An empty array literal whose element type nothing states -- `const r = []`
 * with no annotation, no contextual type, and no write this census could
 * resolve.
 *
 * The checker calls such a literal `never[]`, and `representation/primitives.ts`
 * gives `never` the same physical nothing as `void`, which `storedCarrier`
 * spells `undefined` in a stored position. So the literal's carrier came out
 * `array-object(undefined)` -- a claim that the array can hold NOTHING -- while
 * the cell it fills and every read of it carry the checker's own evolving
 * `any[]`. Two authorities over one storage, and the compiler had picked the
 * strictly less true one: three's `WebGLUniforms.seqWithValue` does `const r =
 * []`, pushes into it, and returns it, and the conversion the return needed
 * (`array-object(undefined) -> array-object(dynamic)`) can never exist, because
 * a carrier that holds nothing is not a carrier the program's values fit.
 *
 * `never` is what the checker says when it has nothing to say here, not a
 * statement that the array is uninhabited -- the program pushes into it. The
 * honest element for "unstated" is the box, which is also exactly what the
 * checker itself answers at every reference (`any[]`).
 *
 * Gated on `never` alone, and on the literal being genuinely EMPTY. A
 * contextually typed `[]` already has a real element and never reaches here;
 * `Array<undefined>` is a statement, shares the `undefined` element carrier,
 * and must keep it -- an `undefined[]` really can hold `undefined`s, and this
 * must not be the thing that decides it cannot.
 */
/**
 * An array whose element type NOTHING states -- `const r = []` with no
 * annotation, no contextual type, and no write this census could resolve --
 * asked of the same three node shapes `inferredArrayElementAt` answers for.
 *
 * The checker calls such an array `never[]`, and `representation/primitives.ts`
 * gives `never` the same physical nothing as `void`, which `storedCarrier`
 * spells `undefined` in a stored position. So the carrier came out
 * `array-object(undefined)` -- a claim that the array can hold NOTHING -- while
 * the program pushes into it. three's `WebGLUniforms.seqWithValue` is the case:
 * `const r = []`, `r.push( u )` in a loop, `return r`, and the conversion the
 * return needs (`array-object(undefined) -> array-object(dynamic)`) can never
 * exist, because a carrier that holds nothing is not one the program's values
 * fit. The refusal was right and the carrier was wrong.
 *
 * `never` is what the checker says when it has nothing to say here, not a proof
 * that the array is uninhabited. The honest element for "unstated" is the box --
 * which is also what the checker itself answers at every reference once its own
 * evolving-array widening gives up (`any[]`).
 *
 * Gated on `never` alone. `any` already reaches the box without this;
 * `Array<undefined>` is a statement that shares the `undefined` element carrier
 * and must keep it, since an `undefined[]` really can hold `undefined`s; and a
 * contextually typed `[]` has a real element and never gets here. Asked only
 * after the census has had its say, because an element the census bound is real
 * evidence and outranks this.
 */
/**
 * Whether an empty `[]` is an arm of a merge that STATES its element type.
 *
 * `r.tokens ? r.tokens : []` over `tokens?: SonioxToken[]` is the shape. TS
 * gives the literal no contextual type here -- a conditional arm inherits the
 * conditional's own, and `const tokens = ...` states none -- so the literal
 * types `never[]` and reaches `unstatedNeverArray` looking exactly like the
 * evidence-free `const r = []` that rule was written for. It is not one: the
 * conditional's own type is `SonioxToken[]`, and that IS a statement of what
 * this arm's elements are, made by the expression the arm belongs to rather
 * than by a contextual type. Boxing it puts two authorities over one merge --
 * `array-object(dynamic)` on the arm, `array-object(native-record-ref)` on the
 * merge -- and no load converts between them, so the program certified and was
 * then refused at emission (`examples/apps/voice-notes`, its whole file).
 *
 * Refusing to box is the entire fix: `ir/lower-narrow.ts`'s `mergeIncoming`
 * already handles this idiom by name, materializing the empty array in the
 * MERGE's own carrier rather than converting into it -- but it recognises the
 * arm by its element deriving to the physical nothing, which is precisely what
 * the box overwrites. The two rules were each right about a different `[]` and
 * this is the one line that says which is which.
 *
 * Asked of the merge's OWN type, not of a contextual type, and only for a
 * non-`never`/non-`any` element: a merge that is itself unstated (`xs ? xs :
 * []` where `xs` is `any[]`) states nothing this arm could adopt, and falls
 * through to the box exactly as before.
 */
const mergeStatesElement = (checker: ts.TypeChecker, layoutTypeAt: (node: ts.Node) => ts.Type, node: ts.Node): boolean => {
  let arm: ts.Node = node
  while (arm.parent && ts.isParenthesizedExpression(arm.parent)) arm = arm.parent
  const parent = arm.parent
  if (!parent) return false
  const isMergeArm =
    (ts.isConditionalExpression(parent) && (parent.whenTrue === arm || parent.whenFalse === arm)) ||
    (ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      (parent.left === arm || parent.right === arm))
  if (!isMergeArm) return false
  // The off switch exists so both arms of the gate that landed this run
  // against ONE dist -- see this repo's `GEA_BAG_OFF`/`GEA_FLOW_CENSUS_OFF`.
  if (process.env['GEA_MERGE_ARRAY_ELEMENT_OFF']) return false
  const merged = layoutTypeAt(parent)
  if (!checker.isArrayType(merged)) return false
  const [element] = checker.getTypeArguments(merged as ts.TypeReference)
  return element !== undefined && (element.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any)) === 0
}

export const unstatedNeverArray = (
  checker: ts.TypeChecker,
  collections: CollectionBindingCensus,
  layoutTypeAt: (node: ts.Node) => ts.Type,
  node: ts.Node
): boolean => {
  const neverElement = (type: ts.Type): boolean => {
    if (!checker.isArrayType(type)) return false
    const [element] = checker.getTypeArguments(type as ts.TypeReference)
    return element !== undefined && (element.flags & ts.TypeFlags.Never) !== 0
  }
  if (ts.isArrayLiteralExpression(node)) {
    if (mergeStatesElement(checker, layoutTypeAt, node)) return false
    // `const empty: never[] = []`, `[] as never[]`: the literal's element IS
    // stated, by the annotation or assertion that gives it its contextual
    // type; only a literal with no context at all (`const r = []`) is the
    // evidence-free case the box exists for.
    const contextual = checker.getContextualType(node)
    if (contextual && checker.isArrayType(contextual)) return false
    return node.elements.length === 0 && collections.arrayElementAt(node) === null && neverElement(layoutTypeAt(node))
  }
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    return !node.type && collections.arrayElementForOwner(node) === null && neverElement(layoutTypeAt(node))
  }
  // A PARAMETER the array reached through a `call-argument` edge is one more
  // name for the caller's storage, and `collection-bindings.ts`'s alias
  // closure already put its declaration in the refused component. It is not a
  // `never[]` candidate -- this census never owned parameters -- so the only
  // question asked of it is the refusal, and the only answer given is the box
  // the caller's own cell already carries.
  // A parameter that STATES its element (an annotation, or a JSDoc `@param`)
  // is not unstated, and the caller's box is not permission to overrule it --
  // that disagreement has no sound conversion and belongs at the refusal, not
  // here. Both spellings are asked, the way `jsdoc-type-names.ts` asks them.
  if (ts.isParameter(node))
    return (
      node.type === undefined &&
      ts.getJSDocType(node) === undefined &&
      ts.getJSDocParameterTags(node).length === 0 &&
      collections.arrayRefusalForOwner(node) !== null &&
      checker.isArrayType(layoutTypeAt(node))
    )
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    if (statesItsOwnType(checker, node)) return false
    // A REFUSED component reads back boxed even where the checker's own
    // flow-sensitive answer at this reference looks concrete. The census
    // admitted this array -- it is an unannotated empty literal whose whole
    // write set it tried and failed to join -- so the storage is the box;
    // letting one read take TypeScript's narrower evolving-array answer gives
    // one array two carriers, and the emitter's only bridge between two
    // `array-object` carriers is a fresh array. For a mutable `ArrayObject`
    // that silently drops everything a callee pushes (three's
    // `getProgramCacheKey`: every program cache key came out identical).
    // Gated on the checker STILL calling this reference an array: where its
    // own answer is a bare `any` (three's `WebGLOutput`, whose `_effects` is
    // assigned an unannotated parameter) the reference is not an array read at
    // all, and boxing it as one gives `_effects.length` an `any` member type
    // over an `ArrayObject` receiver -- two authorities again, the other way.
    if (collections.arrayRefusalForRead(node) !== null && checker.isArrayType(layoutTypeAt(node))) return true
    return collections.arrayElementForRead(node) === null && neverElement(layoutTypeAt(node))
  }
  return false
}

/**
 * Whether the binding a read names DECLARES its type. `export const
 * emptyArray: never[] = [] as never[]` (tsc's core.ts) is stated, not
 * unstated: the empty array is the program's own sentinel -- `type.resolvedBaseTypes
 * = emptyArray` marks a circular resolution in progress and `=== emptyArray`
 * detects it -- and a read of it is `never[]` exactly as the declaration says.
 * The box is the answer for the evidence-free `const r = []`, and the
 * declaration branch above already exempts an annotated declaration; this is
 * the same exemption at the read. Without it the cell carried `never[]` while
 * every read of it carried `any[]` -- two authorities over one storage, 367
 * unmet binding reads on the tsc self-compile, and a target no conversion
 * could honestly serve. What a `never[]` converts INTO is
 * `targets/cpp/conversions.ts`'s question (the one empty array of the target
 * element, by identity); this only keeps the read honest about its source.
 */
const statesItsOwnType = (checker: ts.TypeChecker, node: ts.Identifier | ts.PropertyAccessExpression): boolean => {
  const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node)
  const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return (target?.declarations ?? []).some(
    (declaration) =>
      (ts.isVariableDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertySignature(declaration)) &&
      declaration.type !== undefined
  )
}

export const inferredArrayElementAt = (
  checker: ts.TypeChecker,
  collections: CollectionBindingCensus,
  layoutTypeAt: (node: ts.Node) => ts.Type,
  node: ts.Node
): ts.Type | null => {
  if (ts.isArrayLiteralExpression(node)) return collections.arrayElementAt(node)
  // THE CELL'S OWN DECLARATION -- neither the literal that filled it nor a
  // read of it, and the node a cell's stored carrier is actually published
  // from. `const uvBuffer = []` types as `never[]` at the
  // `VariableDeclaration`, so the cell carried `array-object(undefined)`
  // while every read of it carried the census's real element -- two
  // authorities over one storage, surfacing as an unsatisfiable
  // `binding-read-conversion:array-object(undefined)->array-object(X)` per
  // read rather than as an error anywhere. `typeArgumentsForOwner`'s arm one
  // collection family over exists for exactly this reason and this is its
  // counterpart; see `collections.arrayElementForOwner`.
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    if (node.type) return null
    const declared = layoutTypeAt(node)
    if (!checker.isArrayType(declared)) return null
    return collections.arrayElementForOwner(node)
  }
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return null
  const own = layoutTypeAt(node)
  if (!checker.isArrayType(own)) return null
  if (statesItsOwnType(checker, node)) return null
  // An evolving checker read can already say number[] before the array is
  // published into an object and a later alias writes undefined. The census
  // owns only unannotated empty-array allocations and joins those alias writes;
  // its physical element must therefore survive every read of that same cell,
  // including earlier reads whose local checker view looks concrete.
  return collections.arrayElementForRead(node)
}

/**
 * The array type a `new Array(n)` fills, read off the position it is written
 * into -- `contextualCollectionTypeAt` below, one constructor over.
 *
 * `lib.es5.d.ts` declares `new (arrayLength: number): any[]`, and the
 * non-generic overload is the one every `new Array(n)` selects, so the
 * element reads back `any` whatever the program assigns it to. That `any` is
 * not a statement about the elements; it is the absence of one, and there is
 * nothing for a destination to contradict: ECMA-262 10.4.2.1 makes a fresh
 * array of n HOLES, which has no elements at all. The position the
 * allocation fills DOES state the element, and the checker already checked
 * the allocation against it.
 *
 * It has to be answered here, in the type system, rather than only as the
 * invocation's published result: `partOffsets = new Array(len)` (hono's trie
 * router, over `let partOffsets: number[] | null = null`) puts the allocation
 * behind an assignment whose own value the mapper reads from its right-hand
 * side, and the merge that cell's later reads join would otherwise publish
 * `array-object(dynamic)` against an allocation the invocation published as
 * `array-object(scalar(number))`. Two authorities over one storage, and no
 * conversion between two `array-object` carriers whose elements disagree is
 * installed or ever may be (`targets/cpp/conversions.ts` says why).
 *
 * A union destination is admitted only through its SOLE array arm, which is
 * what `T[] | null` is; two array arms state nothing this could pick between,
 * and an element the destination itself leaves `any`/`unknown` states nothing
 * either. Explicit type arguments (`new Array<T>(n)`) are a statement already
 * and never reach here.
 */
export const contextualArrayConstructTypeAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isNewExpression(node) || node.typeArguments !== undefined) return null
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Array') return null
  const receiver = checker.getSymbolAtLocation(node.expression)
  const receiverDeclaration = receiver?.valueDeclaration
  if (!receiver || receiver.name !== 'Array' || !receiverDeclaration || !receiverDeclaration.getSourceFile().isDeclarationFile) return null
  const own = checker.getTypeAtLocation(node)
  if (!checker.isArrayType(own)) return null
  const [element] = checker.getTypeArguments(own as ts.TypeReference)
  if (!element || (element.flags & ts.TypeFlags.Any) === 0) return null
  const context = statedContextOf(checker, node)
  if (!context) return null
  const arrays = (context.isUnion() ? context.types : [context]).filter((member) => checker.isArrayType(member))
  const [filled] = arrays
  if (!filled || arrays.length !== 1) return null
  const [filledElement] = checker.getTypeArguments(filled as ts.TypeReference)
  if (!filledElement || (filledElement.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
  return filled
}

/**
 * The type a bare `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()`
 * fills, read off the position it is written into, when its own inference
 * states nothing.
 *
 * The checker types every argument-less `new Map()` as `Map<any, any>`: the
 * constructor overload it selects is the non-generic `new (): Map<any, any>`,
 * and no contextual type changes that (`l.s ??= new Map()`, `l.t = new
 * Map()`, `const m: Map<string, number> = new Map()`, `return new Map()`
 * against `Map<string, number> | undefined` -- every one reads back
 * `Map<any, any>`, measured). Those `any`s are not a statement about the
 * keys and values; they are the absence of one. The position the allocation
 * fills DOES state them, and the checker already checked the allocation
 * against it, so the fill is the type.
 *
 * Asked after `inferredCollectionTypeArgumentsAt`: a census that watched the
 * cell's own writes has looked at more than the position's annotation has.
 * Asked only for exactly this shape -- no arguments, no explicit type
 * arguments, every inferred type argument `any`, and a contextual type that
 * is the same generic (or a union of it with absences alone) with stated
 * arguments. `new Box()` on a generic class infers `unknown`, not `any`, and
 * a contextual BASE class for a derived allocation is a different generic
 * target, so neither reaches here. tsc's `classInfo.memberInfos ??= new
 * Map()` and `links.serializedTypes ||= new Map()` are the shape: the merge
 * published the allocation's `keyed-collection(map, dynamic, dynamic)`
 * against a cell declared `Map<K, V>`, an unsatisfiable narrowing per site.
 */
export const contextualCollectionTypeAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isNewExpression(node) || node.typeArguments !== undefined || (node.arguments?.length ?? 0) > 0) return null
  const own = checker.getTypeAtLocation(node)
  const target = genericTargetOf(own)
  if (!target) return null
  const ownArguments = checker.getTypeArguments(own as ts.TypeReference)
  if (ownArguments.length === 0 || !ownArguments.every((argument) => (argument.flags & ts.TypeFlags.Any) !== 0)) return null
  const context = statedContextOf(checker, node)
  if (!context) return null
  const substantive = (context.isUnion() ? context.types : [context]).filter(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) === 0
  )
  const [filled] = substantive
  if (!filled || substantive.length !== 1 || genericTargetOf(filled) !== target) return null
  const filledArguments = checker.getTypeArguments(filled as ts.TypeReference)
  if (filledArguments.some((argument) => (argument.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return null
  return filled
}

/**
 * The stated type of an expression the checker types as a DYNAMIC collection
 * only because the allocation feeding it stated nothing -- the contextual
 * answer above, followed through the syntax that carries an allocation to
 * its use without restating it.
 *
 * `(cache || (cache = new Map())).set(key, value)` is the shape (tsc's
 * `createSymlinkCache`, `links.extendedContainersByFile`): the allocation is
 * typed by its position (`Map<string, number>`, above), but the checker's
 * type of the ASSIGNMENT is the allocation's own `Map<any, any>`, the `||`
 * subtype-REDUCES `Map<string, number> | Map<any, any>` to `Map<any, any>`
 * because the stated one is a subtype of the dynamic one (measured), and the
 * `.set` call's result -- the receiver, per `Map.prototype.set` -- is then
 * resolved off that reduced type. So a value the mapper laid out as
 * `Map<string, number>` flows through three nodes each of which the checker
 * reports as `Map<any, any>`, and the call's result was a
 * `Ref<Map<Value, Value>>` clang refused to assign the receiver into.
 *
 * Followed through exactly the carriers a value passes unchanged: the
 * parentheses, an assignment (whose value IS the RHS), the two merges that
 * yield an operand as-is (`||`, `??` -- `&&` yields the LEFT, which the
 * checker types on its own), and a member call resolved on a stated
 * receiver, whose result is re-read from the stated receiver's own member.
 * A merge whose stated arms differ is built through the checker's internal
 * union (the same guarded reach `derived-expression-type.ts` makes); a
 * checker without it, or a member with overloads this cannot pick between,
 * answers `null` and the checker's own reading stands, exactly as before.
 */
export const statedCollectionTypeAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (ts.isNewExpression(node)) return contextualCollectionTypeAt(checker, node)
  if (ts.isParenthesizedExpression(node)) return statedCollectionTypeAt(checker, node.expression)
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.EqualsToken) return statedCollectionTypeAt(checker, node.right)
    if (operator !== ts.SyntaxKind.BarBarToken && operator !== ts.SyntaxKind.QuestionQuestionToken) return null
    const right = statedCollectionTypeAt(checker, node.right)
    if (!right) return null
    const left = checker.getNonNullableType(statedCollectionTypeAt(checker, node.left) ?? checker.getTypeAtLocation(node.left))
    if (left === right) return right
    const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
    return typeof constructing.getUnionType === 'function' ? constructing.getUnionType([left, right]) : null
  }
  if (!ts.isCallExpression(node) || node.questionDotToken || !ts.isPropertyAccessExpression(node.expression)) return null
  const receiver = statedCollectionTypeAt(checker, node.expression.expression)
  if (!receiver) return null
  const property = checker.getPropertyOfType(receiver, node.expression.name.text)
  if (!property) return null
  const supplied = node.arguments.length
  const signatures = checker
    .getTypeOfSymbolAtLocation(property, node.expression)
    .getCallSignatures()
    .filter((signature) => signature.getTypeParameters() === undefined && signature.getParameters().length >= supplied)
  const [signature] = signatures
  return signature && signatures.length === 1 ? signature.getReturnType() : null
}

/**
 * The type a position states for the value written into it -- the checker's
 * contextual type, except inside a callback passed to a generic call, where
 * the checker answers with the INFERENCE-TIME context: `getOrCreate(map,
 * key, () => new Map())` reads `Map<any, any>` for the arrow's body (measured)
 * because the arrow was contextually typed while `K`/`V` were still being
 * inferred, whereas the call's RESOLVED signature says `() => Map<string,
 * number>`. For a body expression or a direct `return` of an arrow that is an
 * argument of a call, the resolved parameter's own call signature's return
 * type is the statement; everything else is the contextual type as given.
 */
const statedContextOf = (checker: ts.TypeChecker, node: ts.Expression): ts.Type | undefined => {
  const contextual = checker.getContextualType(node)
  const returning = ts.isReturnStatement(node.parent) ? node.parent : node
  const callback = returning.parent
  const body =
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    (callback.body === node ||
      (ts.isBlock(callback.body) && callback.body.statements.length > 0 && callback.body.statements.includes(returning as ts.Statement)))
  if (!body) return contextual
  const call = callback.parent
  if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return contextual
  const index = call.arguments?.findIndex((argument) => argument === callback) ?? -1
  if (index < 0 || call.arguments?.slice(0, index).some(ts.isSpreadElement)) return contextual
  const parameter = checker.getResolvedSignature(call)?.getParameters()[index]
  if (!parameter) return contextual
  const [signature] = checker.getTypeOfSymbolAtLocation(parameter, call).getCallSignatures()
  return signature ? signature.getReturnType() : contextual
}

const genericTargetOf = (type: ts.Type): ts.Type | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return null
  return (type as ts.TypeReference).target
}

/**
 * THE K/(V) A BARE `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()`
 * NEVER STATES, ENTERED INTO THE TYPE SYSTEM -- `inferredArrayElementAt`'s
 * exact counterpart, one collection family over, kept in this module rather
 * than a new sibling for the same reason as every other file at the
 * directory's own 40-file architecture cap: it is the SAME question
 * (`collection-bindings.ts`'s answer entering the type system at the one
 * place a node-keyed override can reach it), asked of the census's OTHER
 * half.
 *
 * `collection-bindings.ts` has answered this since it was written --
 * `typeArgumentsAt` -- but until now nothing in the representation pipeline
 * ever asked it: `grep -rn "typeArgumentsAt" src/` found only the census's
 * own declaration, default and implementation. Unwired since its creation
 * (`a0c56f8d2`: "Add an unwired collection type-argument census (0/56 bind
 * today, by design)"). Every bare `new Map()` in the program is the SAME
 * checker type object (K and V both default to whatever the constructor's
 * own declared defaults are), so -- exactly as for `never[]` above -- only
 * the NODE says which logical collection this is.
 *
 * Three node shapes reach a collection's stored type, and all three are
 * answered from the accessor pair `collection-bindings.ts` already exposes
 * for exactly this:
 *
 * - the allocation itself (`new Map()` -- `typeArgumentsAt`);
 * - the owner's own declaration (`private store = new Map()` types the
 *   FIELD from the `PropertyDeclaration` node, a different node than the
 *   `new Map()` it holds, and a cell rebuilt in more than one place --
 *   `this.m = new Map()` again in a `reset()` method -- has no single
 *   allocation site to ask at all -- `typeArgumentsForOwner`);
 * - a later READ of the cell (`this.store` at `this.store.set(key, value)`
 *   -- `typeArgumentsForRead`).
 *
 * A fourth shape -- the RESULT of a call that returns its own receiver
 * (`Map.prototype.set` returns `this`, so `m.set(a,b).set(c,d)` chains) --
 * is NOT handled here. Recognising it would mean asking, generically, "does
 * this resolved callee return its own receiver" -- a host-protocol fact
 * `host-protocols.ts` does not yet state for the keyed-collection family,
 * and hardcoding the method name `'set'` to answer it is exactly the
 * one-off-syntax shortcut this campaign is trying to stop making. Left
 * unhandled rather than guessed at; see this session's `NOTES.md`.
 *
 * The generic (defaulted) shape this overrides is reused for everything but
 * `typeArguments`: the family, ownership policy and body-independence are
 * already correct -- `representation/collections.ts`'s
 * `deriveKeyedCollection` reads `shape.typeArguments` alone and never
 * `shape.body` at all (`Map`/`Set`'s ambient body is intentionally sealed
 * off one case above it in `representation/derive.ts`'s `'declared'` case)
 * -- so re-deriving the family/declaration here would be a second,
 * competing opinion instead of a strictly narrower one. `body: null` is
 * therefore correct, not a placeholder: nothing downstream of a
 * keyed-collection carrier ever reads it.
 */
export const inferredCollectionTypeArgumentsAt = (
  collections: CollectionBindingCensus,
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  own: ts.Type,
  node: ts.Node
): StructuralTypeId | null => {
  const bound: CollectionTypeArguments | null = ts.isNewExpression(node)
    ? collections.typeArgumentsAt(node)
    : ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)
      ? collections.typeArgumentsForOwner(node)
      : ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
        ? collections.typeArgumentsForRead(node)
        : null
  if (!bound) return null
  const generic = table.get(typeOf(own)).shape
  const direct = overriddenCollectionShape(table, typeOf, bags, bound, generic)
  if (direct !== null) return direct
  // A cell the program lets go ABSENT holds the collection inside a union,
  // and refusing there put the census's answer on the reads and the
  // checker's on the declaration -- the exact two-authorities failure the
  // owner-keyed accessor exists to prevent, one level down.
  //
  // `WebGLRenderer.js`'s `let programs = materialProperties.programs` is the
  // shape: the initializer is `Map<any, any> | undefined`, so this refused
  // and the cell kept `optional(keyed-collection(map, dynamic, dynamic))`,
  // while every read past the `if ( programs === undefined )` guard is a
  // bare `Map` this census answers `keyed-collection(map, string, dynamic)`
  // for -- an unsatisfiable `binding-read-conversion:optional(keyed-
  // collection@...)->keyed-collection(map,string,...)` per read. The
  // narrowing `optional(T) -> T` the reads need is installed and licensed;
  // it simply never applied, because the two `T`s were not the same `T`.
  //
  // Admitted only for a union whose every OTHER member is an absence
  // keyword: `Map<K,V> | undefined` and `Map<K,V> | null` are one storage
  // the program sometimes leaves empty, and the override belongs to the
  // payload. A union with a second substantive member is a genuinely
  // different value in each arm and is refused, exactly as before -- there
  // is no single collection for the census's answer to be about.
  if (generic.kind !== 'union') return null
  const members = generic.members.map((member) => ({ id: member, shape: table.get(member).shape }))
  const payloads = members.filter((member) => member.shape.kind !== 'primitive' || !isAbsenceKeyword(member.shape.primitive))
  const payload = payloads.length === 1 ? payloads[0]! : null
  if (payload === null) return null
  const overridden = overriddenCollectionShape(table, typeOf, bags, bound, payload.shape)
  if (overridden === null) return null
  return table.intern({
    kind: 'union',
    members: generic.members.map((member) => (member === payload.id ? overridden : member))
  })
}

const isAbsenceKeyword = (primitive: string): boolean => primitive === 'undefined' || primitive === 'null'

/**
 * The census's K/(V) written back over one `'declared'` collection shape, or
 * `null` when this shape was never that collection to begin with (a refusal
 * elsewhere already fired, or the node's type genuinely is not one) --
 * refuse by silence, the same as every other node the caller is asked about
 * and has nothing to say for.
 */
const overriddenCollectionShape = (
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  bound: CollectionTypeArguments,
  generic: StructuralShape
): StructuralTypeId | null => {
  if (generic.kind !== 'declared') return null
  // The checker's own key argument stays wherever this census bound none:
  // `key` is `null` for a collection whose K it could not resolve but whose V
  // it could -- a statement about K alone, never a refusal of the collection
  // (`CollectionTypeArguments.key`).
  const keyId = bound.key ? typeOf(bound.key) : generic.typeArguments[0]
  if (keyId === undefined) return null
  // The FAMILY, not `bound.value`, decides the arity: `bound.value` is `null`
  // both for a `Set`/`WeakSet` (which the shape asks nothing about, by
  // `CollectionTypeArguments`'s own doc) AND for a `Map`/`WeakMap` this
  // census bound a key for but never observed a `.set` call on (`new Map()`
  // read only through `.has`/`.get`). Those are NOT the same shape: the first
  // is a genuine 1-argument family, and `deriveKeyedCollection` refuses a
  // 1-argument `map`/`weak-map` outright ("needs exactly 2"). The checker's
  // OWN generic-defaulted instantiation already carries the right arity for
  // whichever family this is -- `MapConstructor`'s bare `new Map()` checks as
  // `Map<unknown, unknown>`, never `Map<unknown>` -- so `generic.typeArguments
  // .length` is what this reads, not the census's own value slot. A `map`/
  // `weak-map` with no bound value keeps the checker's OWN (uninformative)
  // value argument rather than inventing one: only the KEY improved, exactly
  // as much as the evidence supports.
  // `boundValueTypeId`, not `bound.value`: a value slot this census left open
  // as `value-unresolved` can still be answered here, and the cell's carrier
  // and every `.get` off it must read the SAME answer.
  const valueId = boundValueTypeId(table, typeOf, bags, bound)
  const typeArguments = generic.typeArguments.length >= 2 ? [keyId, valueId ?? generic.typeArguments[1]!] : [keyId]
  return table.intern({ kind: 'declared', declaration: generic.declaration, typeArguments, body: null })
}

/**
 * The VALUE slot of a bound collection, finishing the one question
 * `collection-bindings.ts` had to leave open.
 *
 * That census types a `.set` value argument through the checker and the
 * parameter census, and neither can answer `properties.set( object, map )`
 * where `map` is an object bag: the checker says `any`, and the bag census --
 * the one authority that knows -- does not exist yet when it runs
 * (`frontend.ts` places `bags` after `compose()`, because a bag's answer is an
 * `ObjectBagShape` and only `table.intern` turns one into a type). So the
 * unresolved arguments travel here as `valueEvidence`, where the table and
 * both censuses are in scope.
 *
 * ALL-OR-NOTHING, and identical across every argument. A value slot derived
 * half from this census and half from the checker's `any` would be a second
 * authority over one storage -- the defect this whole path exists to close --
 * and two bags that disagree are a real disagreement no later layer resolves,
 * so both answer nothing and the checker's own (uninformative) argument
 * stands, exactly as before.
 */
const boundValueTypeId = (
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  bound: CollectionTypeArguments
): StructuralTypeId | null => {
  if (bound.value) return typeOf(bound.value)
  if (bound.valueEvidence.length === 0) return null
  let agreed: StructuralTypeId | null = null
  for (const evidence of bound.valueEvidence) {
    const resolved = bagShapeTypeAt(table, typeOf, bags, evidence)
    if (resolved === null || (agreed !== null && resolved !== agreed)) return null
    agreed = resolved
  }
  return agreed
}

/**
 * What `collection.get( k )` publishes, when the census -- not the checker --
 * is the one that knows what this collection holds.
 *
 * `inferredCollectionTypeArgumentsAt` above fixes the RECEIVER's own type, and
 * that is not enough: a prototype call's result comes from the CALLEE'S
 * SIGNATURE, which the checker instantiates from the receiver EXPRESSION's
 * type, never from whatever this compiler later selected for it. So
 * `properties.get( renderTarget )` over a `WeakMap` the census bound stays
 * `any`, and every `renderTargetProperties = properties.get( ... )` in three's
 * renderer is a `dynamic -> record` conversion nothing installs -- while the
 * cell the value came OUT of is laid out natively. One storage, two
 * authorities, exactly one operation apart.
 *
 * `V | undefined`, because that is what `Map`/`WeakMap`'s own `get` returns
 * and the census changes only which `V`. The union is built structurally
 * rather than as a `ts.Type`: `ts.TypeChecker.getUnionType` is not public, and
 * this file already interns shapes directly for the same reason.
 *
 * Answers ONLY where a value was actually bound. A `Set`/`WeakSet` has no
 * value (`CollectionTypeArguments`'s own doc), and a `Map` the program only
 * ever reads leaves `value` null rather than inventing one -- both keep the
 * checker's answer, unchanged. The census itself admits only a bare `new
 * Map()` with no type arguments and no constructor argument, so an annotated
 * `Map<string, Foo | null>` never reaches here and the author's own statement
 * stays authoritative.
 */
export const collectionMemberResultTypeAt = (
  collections: CollectionBindingCensus,
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  bags: ObjectBagCensus,
  layoutTypeAt: (node: ts.Node) => ts.Type,
  node: ts.Node
): StructuralTypeId | null => {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const member = callee.name.text
  if (member !== 'get' && member !== 'set' && member !== 'add') return null
  const receiver = callee.expression
  // `typeArgumentsForRead` resolves the receiver to the DECLARATION that owns
  // the collection and answers only for one this census actually bound, so a
  // `.get`/`.set`/`.add` on anything else -- a host object, a class of the
  // program's own with a method of that name -- resolves to no owner and falls
  // through untouched.
  const bound = collections.typeArgumentsForRead(receiver)
  if (!bound) return null
  // `Map.prototype.set` and `Set.prototype.add` return the RECEIVER, so their
  // result is whatever the receiver's own narrowed shape is -- asked through
  // the same function that narrows the receiver itself rather than rebuilt
  // here, so the two cannot state different type arguments for one call. This
  // is not a nicety: `slots.set( 'a', new Slot( 4 ) )` on a bare `new Map()`
  // emitted `Ref<Map<Value, Value>> = Ref<Map<string, Ref<Slot>>>` and clang
  // rejected it outright -- the receiver had the census's answer and the call
  // that returns that same receiver had the checker's.
  if (member !== 'get') return inferredCollectionTypeArgumentsAt(collections, table, typeOf, bags, layoutTypeAt(receiver), receiver)
  const value = boundValueTypeId(table, typeOf, bags, bound)
  if (value === null) return null
  return table.intern({ kind: 'union', members: [value, table.intern({ kind: 'primitive', primitive: 'undefined' })] })
}
