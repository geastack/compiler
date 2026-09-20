import ts from 'typescript'
import { logicalResultTypeOf } from './logical-result-type.js'
export { isOpenTypeForm } from './open-type-form.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import {
  isClassSpelledSourceClass,
  type ExplicitThisCallFrame,
  type FlowInvocationDispatch,
  type FlowInvocationOperands,
  type SourceClass,
  type ValueFlowIndex,
  type ValueWrite
} from './flow/model.js'
import { ownedClassReceiverInventoryOf } from './flow/owned-class-receivers.js'
import { closedValueOriginAuthorityOf } from './flow/callable-reach.js'
import { seededOriginSolver, type SeededOriginNode } from './flow/seeded-origins.js'
import {
  deferredIntrinsicProtocolLedgerOf,
  intrinsicProtocolRequirementKind,
  type DeferredIntrinsicProtocolLedger,
  type IntrinsicProtocolRequirement
} from './deferred-intrinsic-protocols.js'
import { createPropertyKeyDomains, domainMayNameNumeric } from './property-key-domain.js'
import { unwrapErasedExpression } from './producers/erasure.js'

/**
 * The type a COMPOSITE expression's own operator produces, read from its
 * operands rather than invented.
 *
 * Extracted so `parameter-bindings.ts` and `return-bindings.ts` -- two
 * censuses that both walk an expression the checker gave up on, resolving it
 * from evidence the checker DOES have elsewhere -- answer a ternary's arms or
 * a `+`'s operands the SAME way once, rather than each growing its own
 * second, silently-drifting copy of the same three rules. That drift is this
 * compiler's own named defect class (`CLAUDE.md`: "two authorities answering
 * the same question differently"); this file exists so there is one.
 *
 * `parameter-bindings.ts`'s own `compute` does not yet call this -- this
 * module does not own that file and cannot wire it in. The call this module
 * was written to receive, added at the same point every other node kind is
 * dispatched in that file's `compute`, is:
 *
 *   if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
 *     return derivedExpressionType(checker, node, (operand) => known(operand) ?? resolve(operand))
 *   }
 *
 * placed anywhere before the function's final `return null`. `known`/
 * `resolve` are that file's own existing closures (`createResolver`'s
 * locals) -- passing them through as the `read` callback is what keeps this
 * module free of any recursion or memoization of its own: every operand it
 * asks about is resolved by the CALLER's own resolver, under the caller's
 * own cycle guard and round-based memo, so wiring this in changes nothing
 * about either file's termination or fixpoint behaviour. It only adds
 * outcomes to `compute`'s dispatch that were previously `null`.
 *
 * ## What it refuses
 *
 * - A conditional (`a ? b : c`) whose arms disagree -- tested the identical
 *   way two call sites or two `return`s are tested elsewhere in these two
 *   censuses (`widestOf`): agreement is never spelling, and a union of this
 *   compiler's own making is a guess nobody wrote.
 * - `+` over two operands where neither is provably `string`: ECMA-262
 *   12.15.5 makes `+` do string concatenation the moment EITHER operand's
 *   runtime value is a string, and numeric addition otherwise -- so a `+`
 *   between an unresolved operand and anything is refused rather than
 *   assumed numeric. `hue2rgb`'s `p + ( q - p ) * 6 * t` is the shape this
 *   exists for: real arithmetic over real (parameter-derived) numbers, once
 *   every operand resolves, refused whole the moment one does not.
 * - Every other arithmetic/bitwise operator (`-`, `*`, `/`, `%`, `**`, `&`,
 *   `|`, `^`, `<<`, `>>`, `>>>`) unless BOTH operands are provably in the
 *   number domain.
 * - `&&`/`||`/`??` use `logicalResultTypeOf`, the shared partition of which
 *   left values the operator keeps and whether the right can contribute.
 *   A known class or absence combined with a boolean remains a native union;
 *   disagreement between those types does not erase both into checker `any`.
 *   Dynamic operands retain their uncertainty, and Number's falsy part keeps
 *   its Number type because it includes NaN as well as zero.
 * - Comparison operators (`<`, `<=`, `>`, `>=`, `==`, `===`, `!=`, `!==`,
 *   `instanceof`, `in`) are not handled here at all: ECMA-262 fixes their
 *   result at `boolean` regardless of operand types, so the checker already
 *   answers them directly and this function is never reached for one --
 *   `read`/`known` at the BinaryExpression node itself already succeeded
 *   before either caller ever calls in here.
 * - A template expression is always `string` (`ToString` is total), which
 *   the checker already reports without help for the identical reason; this
 *   module's own handling of it is a defensive fallback, never the primary
 *   path.
 */

const numberDomain = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.NumberLike) !== 0
const stringDomain = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.StringLike) !== 0

/**
 * Whether a type says nothing about STORAGE, and so is not evidence.
 *
 * The ONE copy. `parameter-bindings.ts` and `return-bindings.ts` each carried
 * their own before this, with `parameter-bindings.ts`'s adding bare
 * `Function` on top -- it still does, by composing with this rather than
 * restating it, so the base three flags cannot drift between the three
 * modules that ask this question. That module's own `isUnusableEvidence`
 * carries the long-form reasoning for `any`, `void` and `never`.
 *
 * `annotationStatesNothing` is the fourth member and the reason this became
 * shared: a value typed `object` or `{}` is not `any`, so every one of these
 * copies read it as real evidence and published it -- and the parameter
 * census's answer SHADOWS the return census's in the composed view
 * (`composeReturnBindings`), so `function makesBag(): object { return { a: 1,
 * b: 2 } }` had its call answered `object` by one census while the other had
 * already derived the real record. Two authorities, one call, and
 * `model/selected-signature.ts`'s fail-closed guard caught it as a withheld
 * producer. A type that states nothing is not evidence here for exactly the
 * reason `any` is not.
 */
/**
 * The destructuring TARGET an object or array literal is written against,
 * when that target is a binding pattern whose type TypeScript merely IMPLIED
 * from the pattern's shape: `const [a, b] = [1, 2]`, `[a, b] = [1, 2]`,
 * `f([1, 2])` for `function f([x, y])`, `function g({ x } = { x: 1 })`. The
 * checker contextually types such a literal from the pattern -- a tuple, or
 * a record of `any` fields -- while the value is exactly what was written:
 * nothing in the program stated a type, and the language binds the pattern
 * off whatever arrives. `null` for a literal in any other position,
 * including one whose target DECLARES its type, which stays what it states.
 * The returned parameter is the census's cell for the value when the target
 * is a parameter, so an empty literal can take its element from what the
 * other call sites pass rather than from nothing. `element` names the nested
 * binding element whose DEFAULT the literal is: that literal is stored in
 * the element's own slot, never in the root parameter's.
 */
export const impliedPatternTargetOf = (
  checker: ts.TypeChecker,
  node: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression
): { readonly parameter: ts.ParameterDeclaration | null; readonly element?: ts.BindingElement } | null => {
  const parent = node.parent
  const shapeMatches = (name: ts.BindingName): boolean =>
    ts.isArrayLiteralExpression(node) ? ts.isArrayBindingPattern(name) : ts.isObjectBindingPattern(name)
  const impliedPattern = (declaration: ts.VariableDeclaration | ts.ParameterDeclaration): boolean =>
    shapeMatches(declaration.name) &&
    declaration.type === undefined &&
    (!ts.isParameter(declaration) || impliedPatternParameterOf(checker, declaration) !== null)
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && impliedPattern(parent)) return { parameter: null }
  if (ts.isParameter(parent) && parent.initializer === node && impliedPattern(parent)) return { parameter: parent }
  // A nested element's default (`[{ x } = { x: 44 }]`) is read by that
  // element's own pattern, and is typed by the checker from the SAME
  // silhouette the root pattern is: the root decides whether anything was
  // stated.
  if (ts.isBindingElement(parent) && parent.initializer === node && shapeMatches(parent.name)) {
    let root: ts.Node = parent
    while (ts.isBindingElement(root) || ts.isArrayBindingPattern(root) || ts.isObjectBindingPattern(root)) root = root.parent
    if (ts.isParameter(root)) return impliedPatternParameterOf(checker, root) ? { parameter: root, element: parent } : null
    if (ts.isVariableDeclaration(root)) return root.type === undefined ? { parameter: null, element: parent } : null
    return null
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
    const left = ts.isParenthesizedExpression(parent.left) ? parent.left.expression : parent.left
    const targetMatches = ts.isArrayLiteralExpression(node) ? ts.isArrayLiteralExpression(left) : ts.isObjectLiteralExpression(left)
    return targetMatches ? { parameter: null } : null
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node)) {
    const position = parent.arguments.indexOf(node)
    const signature = checker.getResolvedSignature(parent)
    const symbol = signature?.getParameters()[position]
    const declaration = symbol?.valueDeclaration
    if (!declaration || !ts.isParameter(declaration) || declaration.dotDotDotToken || !impliedPattern(declaration)) return null
    return { parameter: declaration }
  }
  return null
}

/**
 * The parameter whose DESTRUCTURING PATTERN `node` is or names, when the
 * pattern's type is one TypeScript merely IMPLIED from the pattern's shape --
 * `function f([x, y])`, `function g({ a, b })` -- with no annotation and no
 * JSDoc tag. That implied type (`[any, any]`, `{ a: any; b: any }`) is a
 * statement about the binding's SYNTAX, not about any value a caller passes:
 * the language binds an array pattern off any iterable of any length, and an
 * object pattern off any object. So for every question this compiler asks --
 * does the parameter state a type (no: the census binds it from the call
 * sites), is the pattern's own type real (no: it is its source's) -- the
 * pattern is "unannotated", and this one predicate is what every site asks so
 * the census, the layout resolver and the ABI projection agree by
 * construction. `null` for a named parameter, an annotated pattern, or a
 * pattern that is not a parameter's own name.
 */
export const impliedPatternParameterOf = (checker: ts.TypeChecker, node: ts.Node): ts.ParameterDeclaration | null => {
  const parameter = ts.isParameter(node)
    ? node
    : (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) && ts.isParameter(node.parent) && node.parent.name === node
      ? node.parent
      : null
  // A JSDoc function-type literal spells its parameters positionally --
  // `@type {function(...number): void}` parses to a ParameterDeclaration whose
  // `name` node is absent. Every predicate below reads `parameter.name`, so the
  // absence has to be answered here rather than crashing the producer.
  if (!parameter || !parameter.name || ts.isIdentifier(parameter.name) || parameter.type || parameter.dotDotDotToken) return null
  if (ts.getJSDocParameterTags(parameter).length > 0 || ts.getJSDocType(parameter) !== undefined) return null
  // A function literal can receive a real parameter type from its surrounding
  // call or assignment even though the parameter has no annotation of its
  // own. `pairs.map(([value, count]) => ...)` is the common case: Array#map's
  // contextual signature states the tuple held by the callback parameter.
  // That tuple is not the checker's pattern-shaped `[any, any]` placeholder
  // and must keep its fixed positions. Otherwise the slot is flattened to an
  // `Array<any>` while each binding element retains its contextual tuple
  // field, leaving one value with two incompatible carriers.
  const callable = parameter.parent
  if (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) {
    const contextual = checker.getContextualType(callable)
    if (contextual) {
      const position = callable.parameters.indexOf(parameter)
      const signatures = checker.getNonNullableType(contextual).getCallSignatures()
      if (
        signatures.length > 0 &&
        signatures.every((signature) => {
          const symbol = signature.getParameters()[position]
          if (!symbol) return false
          const type = checker.getTypeOfSymbolAtLocation(symbol, callable)
          return (type.flags & ts.TypeFlags.Any) === 0
        })
      )
        return null
    }
  }
  return parameter
}

/**
 * The implied-pattern parameter a binding element belongs to, or `null`. The
 * checker types every name in `function f([w = c()])` from the pattern's own
 * silhouette -- `void` here, because the default is the only evidence it has
 * -- and that silhouette is the thing `impliedPatternParameterOf` exists to
 * see through: a layout consult that trusts it skips the census that holds
 * the callers' actual writes. An identifier declared by such an element is
 * the same question asked at a read.
 */
export const impliedPatternElementRootOf = (checker: ts.TypeChecker, node: ts.Node): ts.ParameterDeclaration | null => {
  let current: ts.Node | null = node
  if (ts.isIdentifier(current)) {
    const declarations = checker.getSymbolAtLocation(current)?.declarations
    current = declarations && declarations.length === 1 && declarations[0] && ts.isBindingElement(declarations[0]) ? declarations[0] : null
  }
  if (!current || !ts.isBindingElement(current)) return null
  while (ts.isBindingElement(current) || ts.isArrayBindingPattern(current) || ts.isObjectBindingPattern(current)) current = current.parent
  return ts.isParameter(current) ? impliedPatternParameterOf(checker, current) : null
}

export const isUnusableEvidence = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/**
 * The single-signature call arity of a type, or `null` when it is not a
 * callable with exactly one signature -- `widestOf`'s own guard against
 * joining a CALLING CONVENTION by plain assignability, below.
 */
const soleCallArity = (type: ts.Type): number | null => {
  const signatures = type.getCallSignatures()
  return signatures.length === 1 ? (signatures[0]?.getParameters().length ?? null) : null
}

/**
 * The one type among these that every other fits into, or `null` when no
 * single member holds them all.
 *
 * The ONE join every census in this compiler uses -- `parameter-bindings.ts`
 * (call-site arguments, write-sets, return expressions), `return-bindings.ts`
 * and `local-bindings.ts` (both by way of `derivedExpressionType`, below).
 * Kept to one copy deliberately: two joins answering the same "do these
 * agree" question two ways is the defect class this compiler keeps
 * rediscovering (see this file's own header comment on `derivedExpressionType`).
 *
 * Two writes to one cell, two calls to one parameter, two `return`s from one
 * function: each has to settle on a single carrier, and requiring the observed
 * types to be IDENTICAL refuses a case the program answers itself. In three's
 * renderer `let _gl = context;` is followed by
 * `if ( _gl === null ) _gl = getContext( ... );` -- the writes are
 * `NativeWebGL2RenderingContext` and `NativeWebGL2RenderingContext | null`, and
 * the null check on the very next line says which one the cell is.
 *
 * Nothing is invented here. The answer is always one of the types the program
 * itself produced, admitted only because the checker says every other observed
 * type is assignable to it -- so the storage provably holds all of them. Two
 * unrelated types stay refused, because there the honest answer is neither, and
 * a union of this compiler's own making would be a source-shaped guess at a
 * carrier rather than a reading of one.
 *
 * A CALLING CONVENTION is the one case plain assignability gets wrong. A
 * function declaring FEWER parameters is assignable wherever one declaring
 * more is expected -- TypeScript lets a callee ignore an argument it never
 * named -- so joining `(event) => void` and `() => void` by assignability
 * alone picks `() => void`: the least informative signature, with the
 * parameter every real call site actually passes silently dropped.
 * `EventDispatcher.addEventListener`'s `listener` parameter, bound once bare
 * `Function` stopped being usable evidence (`parameter-bindings.ts`'s
 * `isUnusableEvidence`), is exactly this: joined by assignability it
 * collapsed to `() => void` while `dispatchEvent` calls every listener with
 * one argument, and that reached the emitter as a real ABI mismatch. Requiring
 * the SAME arity when either side is a single-signature callable is the
 * narrow fix -- compatible same-arity callables still agree exactly as
 * `isTypeAssignableTo` already decided; only arity itself stops being
 * something a join can widen away.
 */
/**
 * Whether a JSDoc type node states nothing this compiler can read -- it
 * resolves to `any`, `unknown`, or the checker's internal error type (which
 * carries the `Any` flag).
 *
 * `checker.getTypeFromTypeNode` degrades to this when the node NAMES something
 * the checker cannot bind at that site, and three.js's source does it
 * constantly: `Box3.js` JSDoc-references `Sphere`/`Object3D`/`Triangle`/
 * `Line3`/`Plane`/`Matrix3`/`Matrix4`/`Raycaster`/`Sprite` while its only
 * import is `Vector3`, and every one of those resolves to `any` here.
 *
 * The distinction this draws is the whole point: a tag the checker CAN read is
 * the program stating a type, and stops a census exactly as a TS annotation
 * does. A tag that resolves to nothing is the program stating a type this
 * compiler failed to resolve -- refusing the declaration for it is refusing it
 * for a fact that is not there. `parameter-bindings.ts` has drawn this
 * distinction since the call-site census landed; `return-bindings.ts` and
 * `local-bindings.ts` did not, and bailed on the mere PRESENCE of a tag, which
 * is why 48 of the app's three.js returns stayed `any` while the identical
 * shape on a parameter was rescued. One predicate, three censuses.
 */
/**
 * The type one member of `receiver` produces, or `null` when nothing usable
 * comes back.
 *
 * ONE copy, shared by all three censuses. `parameter-bindings.ts`,
 * `local-bindings.ts` and `field-bindings.ts` each carried a private,
 * byte-identical version of this -- three authorities on one question, which
 * is the defect class this compiler keeps rediscovering. The bug below lived
 * in all three at once precisely because fixing it in one would not have been
 * visible in the others.
 *
 * ## The receiver's own null is not part of the question
 *
 * `getPropertyOfType` on a UNION answers only with properties every member
 * has, and `null` has none -- so `_gl.R32F`, where `_gl` is
 * `NativeWebGL2RenderingContext | null`, came back with no property at all and
 * the whole chain below it refused. That is not the program being unreadable;
 * it is the question being asked of the wrong type. A member read either runs
 * with a non-null receiver or does not run, so what the read PRODUCES is the
 * member of the non-null receiver -- exactly what TypeScript itself answers
 * once flow narrowing has done its work, and `structural-layout-type.ts`
 * already asks it this way.
 *
 * Stripping the null cannot make an answer worse: where the receiver has no
 * null, `getNonNullableType` is the identity, and where it does, the
 * alternative was `null` -- the boxed carrier -- rather than some other type.
 *
 * Measured on the three.js app: 52 boxed identifier reads hang off `WebGLTextures.js`'s
 * `internalFormat` cell alone, whose every write is a `_gl.<CONSTANT>` read.
 */
/**
 * `resolved` when it names ONE calling convention, the convention this call
 * site actually selected when it does not, and `null` when neither.
 *
 * A member can land on a method declaring more than one signature, and there is
 * no primitive joining two overloads into one: substituting the overloaded type
 * trades a `dynamic` carrier for an `unresolved` one -- lattice BOTTOM -- which
 * trips `representation/verify.ts`'s `unresolved-reaches-materialization`
 * guard. That guard is right; the defect is asking the question of the wrong
 * node.
 *
 * A member read that IS a call's callee does not need its overloads joined: the
 * program picked one, with its arguments, and TypeScript resolves exactly that
 * with `getResolvedSignature`. Reading the type back off the selected
 * signature's own declaration yields a single-signature function type -- the
 * real convention this call uses. `string.split( '\n' )` in `WebGLProgram.js`
 * is the whole of it: two `String.prototype.split` overloads, one call.
 *
 * NOT the refuted overload-selector. That one lived inside
 * `resolvedCalleeSignatureType`, where the receiver had collapsed to `never` --
 * so the overload set was a phantom and joining its arms answered a question
 * the program never asked. Here the receiver is a real type a census bound, the
 * overloads are real, and the SELECTION is TypeScript's own rather than one
 * reimplemented here.
 *
 * An overloaded member NOT in callee position keeps its box: nothing at that
 * site says which signature the value stands for, and guessing would give it a
 * convention the program never chose.
 */
/**
 * The type an ELEMENT read produces, when the key is not a name.
 *
 * `lights[ i ]`, `state.probe[ j ]`, `array[ i ]` -- the census resolvers
 * handled only a STRING-LITERAL key, which is a named member spelled with
 * brackets. Every other key was refused, and on the three.js app that is 470 boxed
 * identifier reads at the root of the chain plus everything downstream of
 * them: `const light = lights[ i ]` is the single largest one.
 *
 * A key not known until runtime is answered by the receiver's INDEX signature,
 * which is the only thing that CAN answer it -- and an array's element type is
 * exactly its numeric index signature, so `Light[]` indexed by a `number`
 * yields `Light` with no array special-case. Which signature to ask is decided
 * by the key's own type, resolved by the caller's own operand resolver so each
 * census keeps its own view of what a key expression holds.
 *
 * A receiver with no index signature for that key comes back `null` and stays
 * boxed: the read is then something this cannot describe, and an array whose
 * element type TypeScript inferred as `any` is `any` again by the
 * `isUnusableEvidence` test below rather than an improvement -- except where
 * the caller hands over the program's value-flow index and that index proves
 * a NUMBER key can name nothing any instance of the receiver's class family
 * will ever hold (`absentNumericIndexTypeOf`): the read is then `undefined`.
 */
export const indexedTypeOf = (
  checker: ts.TypeChecker,
  receiver: ts.Type,
  key: ts.Type,
  at: ts.Node,
  flow?: ValueFlowIndex,
  census: SettledReceiverCensus | null = null
): ts.Type | null => {
  const numeric = (key.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0
  const nonNullReceiver = checker.getNonNullableType(receiver)
  // Numeric property keys also address a string index signature. Prefer an
  // explicit numeric signature when present; its narrower value contract
  // must survive alongside the string signature's broader one.
  const indexed = numeric
    ? (checker.getIndexTypeOfType(nonNullReceiver, ts.IndexKind.Number) ?? checker.getIndexTypeOfType(nonNullReceiver, ts.IndexKind.String))
    : checker.getIndexTypeOfType(nonNullReceiver, ts.IndexKind.String)
  if (indexed) return isUnusableEvidence(indexed) ? null : indexed
  return (
    closedObjectLiteralIndexTypeOf(checker, nonNullReceiver, at) ??
    (flow ? absentNumericIndexTypeOf(checker, flow, nonNullReceiver, key, census) : null)
  )
}

/**
 * A closed object LITERAL declares no index signature, but every string (or
 * number) key reading it either lands on one of its own properties or misses
 * -- exactly the fact an index signature states. `const shaderIDs = { a: '1',
 * b: '2' }; shaderIDs[ material.type ]` is not a different question from
 * `Record<string, string>[ k ]`; TypeScript answers it `any` only because
 * nobody wrote the signature down, and the checker's own `getIndexTypeOfType`
 * has nothing to hand back. Synthesizing `(join of the literal's own property
 * types) | undefined` from the literal's OWN declaration is citing the object,
 * not guessing at it -- the same standing `joinOfWrites` already gives a
 * cell's disagreeing writes, applied to a different evidence set.
 *
 * Fires only when EVERY declaration of the receiver's own symbol is an object
 * LITERAL expression: a class instance or a declared interface can grow
 * properties (or hold others already) this reading never sees, so those stay
 * refused. A missing key answers `undefined` -- the language's own reading of
 * an absent property, the same precedent `structural-indexed-access.ts`
 * already relies on for `T[K]` -- so the synthesized type always carries it,
 * matching how the source itself is written: every real call site of this
 * shape (`shaderIDs[ material.type ]` chained into `if ( shaderID )`, a
 * dispatch-table `handlers[ event ]?.()`) already treats the read as
 * possibly-absent.
 */
const closedObjectLiteralIndexTypeOf = (checker: ts.TypeChecker, receiver: ts.Type, at: ts.Node): ts.Type | null => {
  const declarations = receiver.getSymbol()?.declarations
  if (!declarations || declarations.length === 0 || !declarations.every(ts.isObjectLiteralExpression)) return null
  const properties = checker.getPropertiesOfType(receiver)
  if (properties.length === 0) return null
  const valueTypes: ts.Type[] = []
  for (const property of properties) {
    const type = checker.getTypeOfSymbolAtLocation(property, at)
    if (isUnusableEvidence(type)) return null
    valueTypes.push(type)
  }
  const joined = joinOfWrites(checker, valueTypes)
  return joined ? checker.getNullableType(joined, ts.TypeFlags.Undefined) : null
}

/** The source class an INSTANCE type is an instance of -- never `typeof C`, and never a library class whose instances the host shapes. */
const sourceClassOfInstance = (type: ts.Type): SourceClass | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  const target = ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 ? (type as ts.TypeReference).target : type
  if (!target.isClassOrInterface() || (target.objectFlags & ts.ObjectFlags.Class) === 0) return null
  const declaration = target.getSymbol()?.valueDeclaration
  if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return null
  return declaration.getSourceFile().isDeclarationFile ? null : declaration
}

/** `ToPropertyKey` of a Number is its `ToString`: exactly the names a number key can spell. */
const isCanonicalNumericName = (name: string): boolean => String(Number(name)) === name

const KEYED_WRITE_EDGES: ReadonlySet<ValueWrite['edge']> = new Set<ValueWrite['edge']>([
  'index-assignment',
  'compound-assignment',
  'logical-assignment',
  'destructuring',
  'destructuring-default',
  'iteration-binding'
])
/** `Object.<method>` / `Reflect.<method>` calls that add own properties or replace a prototype. */
const OBJECT_PROPERTY_MUTATORS: readonly string[] = ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']
const REFLECT_PROPERTY_MUTATORS: readonly string[] = ['set', 'defineProperty', 'setPrototypeOf']
const INSTANCE_PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never
const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])

const unwrapValueExpression = (expression: ts.Expression): ts.Expression => {
  let value = expression
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression
  return value
}

/** The outermost parenthesis or assertion wrapping `node`: where its value is actually USED. */
const outermostValueWrapperOf = (node: ts.Node): ts.Node => {
  let use = node
  while (
    ts.isParenthesizedExpression(use.parent) ||
    ts.isAsExpression(use.parent) ||
    ts.isTypeAssertionExpression(use.parent) ||
    ts.isSatisfiesExpression(use.parent) ||
    ts.isNonNullExpression(use.parent)
  )
    use = use.parent
  return use
}

/**
 * A settled binding census, asked for the value set of a keyed-write receiver
 * the checker types `any` -- the same question `flow/class-family-member-read.ts`
 * asks its `FamilyReceiverCensus`, stated here structurally so the import
 * direction stays one way.
 */
export interface SettledReceiverCensus {
  readonly typeAt: (node: ts.Node) => ts.Type | null
}
const NO_SETTLED_CENSUS: object = {}
type NumericAbsenceProof = { readonly value: boolean; readonly requirements: readonly IntrinsicProtocolRequirement[] }
// Keyed by the census too: a proof that consulted a settled census may pass
// where the checker-only proof refused, and the two must never share a slot.
const numericAbsenceProofs = new WeakMap<ValueFlowIndex, WeakMap<object, Map<SourceClass, NumericAbsenceProof>>>()
const activeNumericAbsenceProofs = new WeakMap<ValueFlowIndex, WeakMap<object, Set<SourceClass>>>()
const numericAbsenceKeyDomains = new WeakMap<ValueFlowIndex, ReturnType<typeof createPropertyKeyDomains>>()
const numericAbsenceDebug = process.env['GEA_INDEXED_ABSENCE_DEBUG']
/**
 * ⛔ UNSOUND MEASUREMENT ARM. `GEA_INDEXED_ABSENCE_FORCE=<class>|*` drops the
 * KEYED-WRITE clause of the proof below and nothing else, so the carriers that
 * clause alone is holding open can be counted before any work is spent making
 * it discharge honestly. It admits a numeric-named property this program may
 * really create; never set it for a build whose output is kept.
 */
const numericAbsenceForce = process.env['GEA_INDEXED_ABSENCE_FORCE']
/** `GEA_NUMERIC_ABSENCE=0` refuses the numeric-absence proof; see its use for why. */
const numericAbsenceEnabled = process.env['GEA_NUMERIC_ABSENCE']

/**
 * `undefined`, when a NUMBER key can name no property that any instance of the
 * receiver's class family will ever hold; `null` when that is not proved.
 *
 * three's `WebGLUtils.convert( p )` ends `return ( gl[ p ] !== undefined ) ?
 * gl[ p ] : null;`, `gl` a `NativeWebGL2RenderingContext` and `p` a numeric
 * format constant. The context declares no member a number can name, so the
 * read is `undefined` on every call -- but the checker reads it `any`, the
 * return census refused `convert` whole (`return-index-signature-absent`), and
 * everything downstream of it (`getInternalFormat` and the texture upload
 * paths) carried a dynamic value.
 *
 * JavaScript reads an absent property as `undefined`, and a number key spells
 * only canonical numeric strings. So the read is absent on every instance when:
 *
 * - every value the receiver can hold is an instance of an ENUMERATED set of
 *   source classes (`ownedClassReceiverInventoryOf`), none declaring an index
 *   signature, a member whose name is a canonical numeric string anywhere on
 *   its prototype chain, or a computed member whose key could spell one -- and
 *   none with a library base, whose instances the host shapes;
 * - no write can create such a property on a family member: no named write of
 *   a numeric name (`o[ 3 ] = v` is one), no computed write whose key domain
 *   (`property-key-domain.ts`) may spell one, no `__proto__` write, and no
 *   reflective definition or prototype replacement -- each unless its receiver
 *   provably cannot hold a family member. That is
 *   `flow/class-family-member-read.ts`'s closure rule, restated for a NAME SET
 *   (it answers one identifier-shaped name and refuses numeric ones up front);
 * - `Object.prototype`, the one intrinsic every such chain ends in, is never
 *   handed anywhere that could give it a numeric property: every mention of it
 *   is a member read off it or an identity comparison, every `getPrototypeOf`
 *   result is used the same way, and no reflective mutator is referenced other
 *   than as a direct callee this scan reads. `global-host-mutations.ts` states
 *   the general form of this taint, but it reads the settled structural mapper
 *   and so cannot be consulted from inside the binding fixpoint that asks this.
 *
 * A string key refuses outright: it can spell a declared member's own name.
 * `GEA_INDEXED_ABSENCE_DEBUG=<class>|*` prints the first failing proof.
 */
const absentNumericIndexTypeOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Type,
  key: ts.Type,
  census: SettledReceiverCensus | null
): ts.Type | null => {
  const keys = key.isUnion() ? key.types : [key]
  if (!keys.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0)) return null
  const arms = receiver.isUnion() ? receiver.types : [receiver]
  const censusKey: object = census ?? NO_SETTLED_CENSUS
  for (const arm of arms) {
    const root = sourceClassOfInstance(arm)
    if (!root) return null
    let proofsByCensus = numericAbsenceProofs.get(flow)
    if (!proofsByCensus) numericAbsenceProofs.set(flow, (proofsByCensus = new WeakMap()))
    let proofs = proofsByCensus.get(censusKey)
    if (!proofs) proofsByCensus.set(censusKey, (proofs = new Map()))
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    let proved = proofs.get(root)
    if (proved === undefined) {
      let activeByCensus = activeNumericAbsenceProofs.get(flow)
      if (!activeByCensus) activeNumericAbsenceProofs.set(flow, (activeByCensus = new WeakMap()))
      let active = activeByCensus.get(censusKey)
      if (!active) activeByCensus.set(censusKey, (active = new Set()))
      if (active.has(root)) return null
      active.add(root)
      try {
        const compute = () => {
          // The numeric twin of `class-family-member-read.ts`'s
          // `GEA_FAMILY_MEMBER_ABSENT_KEYS`, and it exists for the same reason.
          // The obligation below is DEFERRED: `requirePrototypeKeys` admits it
          // on the spot (it only records into the active capture) and the
          // sealed host census judges it much later. Under the `*` wildcard it
          // cannot be judged true, and the result is a certification
          // diagnostic that costs the WHOLE program its certificate -- a sound
          // outcome, but a worse one than the boxed read this proof replaced,
          // since refusing here simply leaves the read as it was. `0` refuses
          // the proof outright and keeps the program compiling; the default is
          // unchanged. Remove this switch when the census stops taking the
          // wildcard, exactly as that sibling switch says.
          // ... and the installed hosts state the same refusal for every build
          // that loads them: `PluginCapabilities.refusesObjectPrototypeAbsenceProofs`.
          if (numericAbsenceEnabled === '0' || ledger?.refusesObjectPrototypeAbsenceProofs === true) return false
          // Numeric absence also depends on the complete numeric key domain of
          // Object.prototype. Record that dependency in the same deferred
          // ledger as the class-family proof; otherwise an opaque call may
          // mutate a numeric prototype key after this provisional result.
          if (ledger?.requirePrototypeKeys('Object', { numeric: true }, root) !== true) return false
          return numericNamesAbsentFrom(checker, flow, root, census)
        }
        proved = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
        proofs.set(root, proved)
      } finally {
        active.delete(root)
      }
    }
    if (!proved.value || (proved.requirements.length > 0 && ledger?.include(proved.requirements) !== true)) return null
  }
  return checker.getUndefinedType()
}

/**
 * Whether a numeric element read is proven to miss every owned class-family
 * instance.  This is deliberately separate from `indexedTypeOf`: an
 * `undefined` result can also come from an ordinary index signature or a
 * checker-derived type, neither of which licenses bypassing the runtime
 * property lookup.
 */
export const numericIndexAbsenceProven = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Type,
  key: ts.Type,
  census: SettledReceiverCensus | null = null
): boolean => deferredIntrinsicProtocolLedgerOf(flow) !== null && absentNumericIndexTypeOf(checker, flow, receiver, key, census) !== null

const numericNamesAbsentFrom = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  root: SourceClass,
  census: SettledReceiverCensus | null
): boolean => {
  // `GEA_INDEXED_ABSENCE_DEBUG` used to report only the FIRST failing clause,
  // because every refusal below was `return refuse(...)`: the function ended
  // there, so a class refused by two keyed writes only ever showed one, and
  // finding the second took a re-run with the first fixed. While watched,
  // `refuse` still prints and records every site it is called at, but the loop
  // and mutator-scan sites stop RETURNING on the first one and keep walking --
  // the boolean this function hands back is unchanged either way, since a
  // proof that refuses once is exactly as refused as one that refuses five
  // times; only the reporting is exhaustive now.
  const enumerating = numericAbsenceDebug !== undefined && (numericAbsenceDebug === '*' || numericAbsenceDebug === root.name?.text)
  const clauseCounts = new Map<string, number>()
  let refused = 0
  const refuse = (reason: string, at?: ts.Node): false => {
    if (numericAbsenceDebug !== undefined && (numericAbsenceDebug === '*' || numericAbsenceDebug === root.name?.text)) {
      const file = at?.getSourceFile()
      const where =
        at && file
          ? `${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(at.getStart()).line + 1} ${at.getText().slice(0, 80)}`
          : ''
      process.stderr.write(`[INDEXED-ABSENCE] ${root.name?.text ?? '(anonymous)'} ${reason} ${where}\n`)
    }
    refused += 1
    clauseCounts.set(reason, (clauseCounts.get(reason) ?? 0) + 1)
    return false
  }
  // Every path that ends this proof funnels through here, so the summary line
  // is emitted exactly once per call, whether the proof stopped at the first
  // refusal (not enumerating) or walked every site (enumerating).
  const summarize = (): false => {
    if (enumerating && refused > 0)
      process.stderr.write(
        `[INDEXED-ABSENCE-SUMMARY] ${root.name?.text ?? '(anonymous)'} refused=${refused} clauses=${[...clauseCounts]
          .map(([clause, count]) => `${clause}:${count}`)
          .join(',')}\n`
      )
    return false
  }
  const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([root]))
  if (!inventory) {
    refuse('family-not-closed')
    return summarize()
  }
  let domains = numericAbsenceKeyDomains.get(flow)
  // Every write the index holds is already reachable: the flow walk prunes
  // unreachable members before it records anything.
  if (!domains) numericAbsenceKeyDomains.set(flow, (domains = createPropertyKeyDomains(checker, flow, () => true)))
  const keys = domains

  // The family, each member's source ancestry, and what each declares.
  const family = new Map<SourceClass, ts.InterfaceType>()
  const ancestorsOf = new Map<SourceClass, ReadonlySet<SourceClass>>()
  const chain = new Set<SourceClass>()
  // Each member of the inventory is an independent question -- a bad member B
  // says nothing about member A -- so while enumerating, a refused member is
  // skipped (it contributes nothing to `family`/`ancestorsOf`/`chain`, which
  // is safe: every later reader of those maps already tolerates an absent
  // entry) rather than ending the whole proof before the rest are checked.
  for (const member of inventory.classes) {
    const symbol = member.name ? checker.getSymbolAtLocation(member.name) : checker.getTypeAtLocation(member).getSymbol()
    const instance = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (!instance?.isClassOrInterface()) {
      refuse('family-member-untyped', member)
      if (!enumerating) return summarize()
      continue
    }
    if (checker.getIndexInfosOfType(instance).length > 0) {
      refuse('index-signature', member)
      if (!enumerating) return summarize()
      continue
    }
    const numeric = checker.getPropertiesOfType(instance).find((property) => isCanonicalNumericName(property.name))
    if (numeric) {
      refuse('numeric-member', numeric.valueDeclaration ?? member)
      if (!enumerating) return summarize()
      continue
    }
    const ancestors = new Set<SourceClass>()
    let libraryBase: ts.Node | null = null
    const visit = (type: ts.InterfaceType): void => {
      for (const base of checker.getBaseTypes(type)) {
        const declaration = sourceClassOfInstance(base)
        if (!declaration) {
          libraryBase ??= member
          return
        }
        if (ancestors.has(declaration)) continue
        ancestors.add(declaration)
        const target = ((base as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 ? (base as ts.TypeReference).target : base
        if (target.isClassOrInterface()) visit(target)
      }
    }
    visit(instance)
    if (libraryBase) {
      refuse('library-base', libraryBase)
      if (!enumerating) return summarize()
      continue
    }
    family.set(member, instance)
    ancestorsOf.set(member, ancestors)
    chain.add(member)
    for (const ancestor of ancestors) chain.add(ancestor)
  }
  for (const owner of chain) {
    // The question is whether any member of the chain is spelled with a
    // COMPUTED name that may be numeric. A constructor function's equivalent is
    // `this[ expr ] = v` in its body, which this walk does not read -- so it
    // cannot say there is none.
    if (!isClassSpelledSourceClass(owner)) {
      refuse('constructor-function-computed-members', owner)
      if (!enumerating) return summarize()
      continue
    }
    for (const element of owner.members) {
      const name = element.name
      if (!name || !ts.isComputedPropertyName(name)) continue
      if ((ts.getCombinedModifierFlags(element) & ts.ModifierFlags.Static) !== 0) continue
      if (domainMayNameNumeric(keys.of(name.expression))) {
        refuse('computed-member', element)
        if (!enumerating) return summarize()
      }
    }
  }

  // "May hold a family member", from the receiver's static type and its
  // allocation -- the same two questions `class-family-member-read.ts` asks.
  const holdsFamily = (declaration: SourceClass): boolean =>
    family.has(declaration) || [...ancestorsOf.values()].some((ancestors) => ancestors.has(declaration))
  // The checker's type, or -- only where the checker says nothing -- the
  // settled census's. Three stores through receivers the checker types `any`
  // (`currentRenderState.state.transmissionRenderTarget[ camera.id ] = new
  // WebGLRenderTarget(...)`, `programs[ programCacheKey ] = program`); the
  // census types the first `Record<string, WebGLRenderTarget | undefined>`,
  // a carrier no class instance can be stored into, so the write cannot land
  // on a family member. Those two writes alone held `WebGLUtils.convert`'s
  // result -- and 409 results downstream of it -- dynamic on the three.js app.
  const typeOf = (expression: ts.Expression): ts.Type => {
    const own = checker.getTypeAtLocation(expression)
    if (!census || (own.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return own
    const settled = census.typeAt(expression)
    return settled && (settled.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 ? settled : own
  }
  const typeMayHold = (type: ts.Type, depth = 0): boolean => {
    if (depth > 8 || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
    if (type.isUnionOrIntersection()) return type.types.some((part) => typeMayHold(part, depth + 1))
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type)
      return constraint === undefined || constraint === type || typeMayHold(constraint, depth + 1)
    }
    if ((type.flags & INSTANCE_PRIMITIVE_FLAGS) !== 0) return false
    if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) === 0) return true
    const declaration = sourceClassOfInstance(type)
    if (declaration) return holdsFamily(declaration)
    return [...family.values()].some((instance) => checker.isTypeAssignableTo(instance, type))
  }
  // The shared source-slot proof accounts for replacements and receiver
  // escapes; a descriptor inventory or a field annotation does not. Retain
  // that proof context across this query's parameter and field continuations.
  let origins: ReturnType<typeof closedValueOriginAuthorityOf> | undefined
  const sourcesOf = (anchor: ts.Expression) => (origins ??= closedValueOriginAuthorityOf(checker, flow, anchor))
  const through = (values: readonly ts.Expression[]): SeededOriginNode<ts.Expression> => ({
    admitted: true,
    seed: false,
    dependencies: values.map(unwrapValueExpression)
  })
  const excluded = (yes: boolean): SeededOriginNode<ts.Expression> => ({ admitted: yes, seed: yes, dependencies: [] })
  // A recursive alias must be grounded in an actual disjoint allocation.
  // Revisiting an active expression is not itself evidence of disjointness.
  const nonFamilyOrigin = seededOriginSolver<ts.Expression>((value) => {
    if (
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      ts.isRegularExpressionLiteral(value)
    )
      return excluded(true)
    if (ts.isConditionalExpression(value)) return through([value.whenTrue, value.whenFalse])
    if (
      ts.isBinaryExpression(value) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        value.operatorToken.kind
      )
    )
      return through([value.left, value.right])
    if (ts.isNewExpression(value)) {
      const constructed = checker.getTypeAtLocation(value)
      const declaration = sourceClassOfInstance(constructed)
      if (declaration) {
        const allocations = sourcesOf(value).classAllocationsOf(value)
        return excluded(allocations !== null && [...allocations.classes].every((owner) => !holdsFamily(owner)))
      }
      const callee = checker.getSymbolAtLocation(value.expression)?.valueDeclaration
      return excluded(callee !== undefined && callee.getSourceFile().isDeclarationFile && !typeMayHold(constructed))
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const stored = sourcesOf(value).fieldValuesOf(value)
      return stored !== null && stored.length > 0 ? through(stored) : excluded(false)
    }
    if (!ts.isIdentifier(value)) return excluded(!typeMayHold(typeOf(value)))
    const declaration = flow.targetOf(value)?.declaration
    if (declaration && ts.isParameter(declaration)) {
      const incoming = sourcesOf(value).parameterValuesOf(declaration)
      return incoming !== null && incoming.length > 0 ? through(incoming) : excluded(false)
    }
    if (!declaration || !ts.isVariableDeclaration(declaration)) return excluded(false)
    const values = sourcesOf(value).bindingValuesOf(declaration)
    return values !== null && values.length > 0 ? through(values) : excluded(false)
  })
  const excludesFamily = (expression: ts.Expression): boolean => nonFamilyOrigin(unwrapValueExpression(expression)) === 'allocated'
  const mayHold = (expression: ts.Expression | null | undefined): boolean =>
    !expression || (typeMayHold(typeOf(expression)) && !excludesFamily(expression))
  const keyMayNameNumeric = (expression: ts.Expression | undefined): boolean =>
    expression === undefined || ts.isSpreadElement(expression) || domainMayNameNumeric(keys.of(expression))
  /** Whether an `Object.assign` source or `defineProperties` map can carry a numeric key: only a spread-free literal says it cannot. */
  const literalMayNameNumeric = (expression: ts.Expression | undefined): boolean => {
    const literal = expression && unwrapValueExpression(expression)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return true
    return literal.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true
      const key = property.name
      if (!key) return true
      if (ts.isComputedPropertyName(key)) return domainMayNameNumeric(keys.of(key.expression))
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return isCanonicalNumericName(key.text)
      return true
    })
  }

  // Named, keyed and prototype writes.
  for (const write of flow.allWrites) {
    if (write.slot === 'member' && write.member !== null) {
      // A delete never creates a property; a literal's own member is not an
      // expando on an object that already existed; a binding pattern's member
      // edge is a READ of its source.
      if (write.edge === 'delete') continue
      if (ts.isPropertyAssignment(write.site) || ts.isShorthandPropertyAssignment(write.site)) continue
      if ((write.edge === 'destructuring' || write.edge === 'destructuring-default') && ts.isBindingElement(write.site)) continue
      if (write.member === '__proto__' && mayHold(write.naming)) {
        refuse('prototype-write', write.site)
        if (!enumerating) return summarize()
      }
      if (isCanonicalNumericName(write.member) && mayHold(write.naming)) {
        refuse('numeric-member-write', write.site)
        if (!enumerating) return summarize()
      }
      continue
    }
    if (write.slot !== 'element' || !KEYED_WRITE_EDGES.has(write.edge)) continue
    const receiver = write.naming
    const access = receiver?.parent
    if (!receiver || !access || !ts.isElementAccessExpression(access) || access.expression !== receiver) {
      if (mayHold(receiver)) {
        refuse('keyed-write-unattributed', write.site)
        if (!enumerating) return summarize()
      }
      continue
    }
    // This is the shape the debug arm was built for: the three.js app's `programs[
    // programCacheKey ] = program` and `state.transmissionRenderTarget[
    // camera.id ] = ...` are TWO independent keyed writes onto the same class
    // family, and the old first-refusal-ends-the-proof behavior meant a run
    // could only ever report one of them.
    if (domainMayNameNumeric(keys.of(access.argumentExpression)) && mayHold(receiver)) {
      if (numericAbsenceForce === undefined || (numericAbsenceForce !== '*' && numericAbsenceForce !== root.name?.text)) {
        refuse('keyed-write', write.site)
        if (!enumerating) return summarize()
        continue
      }
      refuse('keyed-write(FORCED-PAST)', write.site)
    }
  }

  // Reflective definitions and prototype replacement, at every direct call.
  for (const { call } of flow.calls) {
    if (!ts.isCallExpression(call)) continue
    const callee = unwrapValueExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) continue
    const method = callee.name.text
    const owner = callee.expression
    const onObject =
      OBJECT_PROPERTY_MUTATORS.includes(method) && isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner))
    const onReflect = !onObject && REFLECT_PROPERTY_MUTATORS.includes(method) && isStandardGlobalValue(checker, owner, 'Reflect')
    if (!onObject && !onReflect) continue
    const args = call.arguments
    // A spread hides which argument is the target and which the key, so the
    // rest of this call's own checks below (which index into `args`
    // positionally) cannot run meaningfully -- skip straight to the next call
    // even while enumerating.
    if (args.some(ts.isSpreadElement)) {
      refuse('reflective-spread-arguments', call)
      if (!enumerating) return summarize()
      continue
    }
    const target = args[0]
    if (method === 'setPrototypeOf') {
      if (mayHold(target)) {
        refuse('prototype-replaced', call)
        if (!enumerating) return summarize()
      }
      continue
    }
    if (method === 'assign') {
      if (mayHold(target) && args.slice(1).some(literalMayNameNumeric)) {
        refuse('object-assign', call)
        if (!enumerating) return summarize()
      }
      continue
    }
    if (method === 'defineProperties') {
      if (mayHold(target) && literalMayNameNumeric(args[1])) {
        refuse('define-properties', call)
        if (!enumerating) return summarize()
      }
      continue
    }
    // `defineProperty` (either owner) and `Reflect.set`, whose optional fourth
    // argument is the receiver a data property is created on.
    const receivers = method === 'set' && args[3] ? [target, args[3]] : [target]
    if (receivers.some(mayHold) && keyMayNameNumeric(args[1])) {
      refuse(`reflective-${method}`, call)
      if (!enumerating) return summarize()
    }
  }

  // The intrinsics themselves, resolved from the standard library -- a program
  // that shadows `Object` or `Reflect` at the root's own scope proves nothing.
  const intrinsic = (name: string): ts.Type | null => {
    const symbol = checker.resolveName(name, root, ts.SymbolFlags.Value, false)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    return symbol && declaration?.getSourceFile().isDeclarationFile ? checker.getTypeOfSymbolAtLocation(symbol, root) : null
  }
  const objectConstructor = intrinsic('Object')
  const reflect = intrinsic('Reflect')
  const objectPrototype = objectConstructor?.getProperty('prototype')
  if (!objectConstructor || !reflect || !objectPrototype) {
    refuse('intrinsics-unresolved')
    return summarize()
  }
  const isDirectCallee = (reference: ts.MemberName): boolean => {
    const access = reference.parent
    return (
      ts.isPropertyAccessExpression(access) &&
      access.name === reference &&
      ts.isCallExpression(outermostValueWrapperOf(access).parent) &&
      unwrapValueExpression((outermostValueWrapperOf(access).parent as ts.CallExpression).expression) === access
    )
  }
  // `const define = Object.defineProperty; define( o, 0, d )` calls a mutator
  // the scan above never sees as one.
  const mutators = [
    ...OBJECT_PROPERTY_MUTATORS.map((method) => objectConstructor.getProperty(method)),
    ...REFLECT_PROPERTY_MUTATORS.map((method) => reflect.getProperty(method))
  ]
  for (const symbol of mutators) {
    if (!symbol) continue
    for (const reference of flow.memberReferencesToSymbol(symbol)) {
      if (!isDirectCallee(reference)) {
        refuse('reflective-mutator-escapes', reference)
        if (!enumerating) return summarize()
      }
    }
  }
  /** A value that may be `Object.prototype` is only ever read from or compared. */
  const onlyReadOrCompared = (value: ts.Node): boolean => {
    const use = outermostValueWrapperOf(value)
    const parent = use.parent
    return (
      (ts.isPropertyAccessExpression(parent) && parent.expression === use) ||
      (ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind))
    )
  }
  for (const reference of flow.memberReferencesToSymbol(objectPrototype)) {
    const access = reference.parent
    if (!ts.isPropertyAccessExpression(access) || access.name !== reference || !onlyReadOrCompared(access)) {
      refuse('object-prototype-escapes', reference)
      if (!enumerating) return summarize()
    }
  }
  for (const symbol of [objectConstructor.getProperty('getPrototypeOf'), reflect.getProperty('getPrototypeOf')]) {
    if (!symbol) continue
    for (const reference of flow.memberReferencesToSymbol(symbol)) {
      if (!isDirectCallee(reference) || !onlyReadOrCompared(outermostValueWrapperOf(reference.parent).parent)) {
        refuse('prototype-read-escapes', reference)
        if (!enumerating) return summarize()
      }
    }
  }
  if (refused > 0) return summarize()
  return true
}

type ClosedLiteralAbsenceProof = { readonly value: boolean; readonly requirements: readonly IntrinsicProtocolRequirement[] }
const closedLiteralAbsenceProofs = new WeakMap<ValueFlowIndex, WeakMap<ts.Type, Map<string, ClosedLiteralAbsenceProof>>>()
const closedLiteralAbsenceDebug = process.env['GEA_CLOSED_LITERAL_ABSENCE_DEBUG']

/** Same question `typeMayHold` (above, in `numericNamesAbsentFrom`) asks for a class family, restated for ONE structural record: object literals have no subclasses, so "may hold" is plain assignability. */
const literalMayHoldType = (checker: ts.TypeChecker, candidate: ts.Type, record: ts.Type, depth = 0): boolean => {
  if (depth > 8 || (candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
  if (candidate.isUnionOrIntersection()) return candidate.types.some((part) => literalMayHoldType(checker, part, record, depth + 1))
  if ((candidate.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(candidate)
    return constraint === undefined || constraint === candidate || literalMayHoldType(checker, constraint, record, depth + 1)
  }
  if ((candidate.flags & INSTANCE_PRIMITIVE_FLAGS) !== 0) return false
  if ((candidate.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) === 0) return true
  // Is ONE OF OUR OWN instances assignable to the write's receiver -- could the
  // receiver, per its own declared shape, actually be holding this record?
  return checker.isTypeAssignableTo(record, candidate)
}

/**
 * Whether NO write anywhere in the program can put `name` on `record` --
 * `numericNamesAbsentFrom`'s write inventory (named/keyed writes, `Object`/
 * `Reflect` mutators, prototype escapes), restated for one closed object
 * LITERAL instead of an owned class family. There is no inheritance chain to
 * close and no constructor-function computed-member case to refuse, because a
 * literal has neither; there is still every other way a program can hand a
 * plain object a new key.
 */
const closedLiteralMemberAbsent = (checker: ts.TypeChecker, flow: ValueFlowIndex, record: ts.Type, name: string, at: ts.Node): boolean => {
  const refuse = (reason: string, site?: ts.Node): false => {
    if (closedLiteralAbsenceDebug !== undefined) {
      const file = site?.getSourceFile()
      const where =
        site && file
          ? ` ${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(site.getStart()).line + 1} ${site.getText().slice(0, 80)}`
          : ''
      process.stderr.write(`[CLOSED-LITERAL-ABSENCE] ${name} ${reason}${where}\n`)
    }
    return false
  }
  // Only a class instance or a declared interface can grow members this
  // reading never sees; a literal's own declaration(s) are the whole story.
  const declarations = record.getSymbol()?.declarations
  if (!declarations || declarations.length === 0 || !declarations.every(ts.isObjectLiteralExpression)) return refuse('not-a-closed-literal')
  // An index signature already answers every named key through `indexedTypeOf`;
  // reaching here at all means none was stated, but a defensive check keeps
  // this proof correct even if that changes upstream.
  if (checker.getIndexInfosOfType(record).length > 0) return refuse('index-signature')

  const domains = createPropertyKeyDomains(checker, flow, () => true)
  const typeOf = (expression: ts.Expression): ts.Type => checker.getTypeAtLocation(expression)
  const mayHold = (expression: ts.Expression | null | undefined): boolean =>
    !!expression && literalMayHoldType(checker, typeOf(expression), record)
  const keyMayName = (expression: ts.Expression | undefined): boolean =>
    expression === undefined || ts.isSpreadElement(expression) || domains.mayName(domains.of(expression), name)
  /** Whether an `Object.assign` source or `defineProperties` map can carry `name`: only a spread-free literal says it cannot. */
  const literalMayName = (expression: ts.Expression | undefined): boolean => {
    const literal = expression && unwrapValueExpression(expression)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return true
    return literal.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true
      const key = property.name
      if (!key) return true
      if (ts.isComputedPropertyName(key)) return domains.mayName(domains.of(key.expression), name)
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return key.text === name
      return true
    })
  }

  // Named, keyed and prototype writes.
  for (const write of flow.allWrites) {
    if (write.slot === 'member' && write.member !== null) {
      // A delete never creates a property; a literal's own member is not an
      // expando on an object that already existed; a binding pattern's member
      // edge is a READ of its source.
      if (write.edge === 'delete') continue
      if (ts.isPropertyAssignment(write.site) || ts.isShorthandPropertyAssignment(write.site)) continue
      if ((write.edge === 'destructuring' || write.edge === 'destructuring-default') && ts.isBindingElement(write.site)) continue
      if (write.member === '__proto__' && mayHold(write.naming)) return refuse('prototype-write', write.site)
      if (write.member === name && mayHold(write.naming)) return refuse('named-write', write.site)
      continue
    }
    if (write.slot !== 'element' || !KEYED_WRITE_EDGES.has(write.edge)) continue
    const target = write.naming
    const access = target?.parent
    if (!target || !access || !ts.isElementAccessExpression(access) || access.expression !== target) {
      if (mayHold(target)) return refuse('keyed-write-unattributed', write.site)
      continue
    }
    if (keyMayName(access.argumentExpression) && mayHold(target)) return refuse('keyed-write', write.site)
  }

  // Reflective definitions and prototype replacement, at every direct call.
  for (const { call } of flow.calls) {
    if (!ts.isCallExpression(call)) continue
    const callee = unwrapValueExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) continue
    const method = callee.name.text
    const owner = callee.expression
    const onObject =
      OBJECT_PROPERTY_MUTATORS.includes(method) && isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner))
    const onReflect = !onObject && REFLECT_PROPERTY_MUTATORS.includes(method) && isStandardGlobalValue(checker, owner, 'Reflect')
    if (!onObject && !onReflect) continue
    const args = call.arguments
    // A spread hides which argument is the target and which the key.
    if (args.some(ts.isSpreadElement)) return refuse('reflective-spread-arguments', call)
    const target = args[0]
    if (method === 'setPrototypeOf') {
      if (mayHold(target)) return refuse('prototype-replaced', call)
      continue
    }
    if (method === 'assign') {
      if (mayHold(target) && args.slice(1).some(literalMayName)) return refuse('object-assign', call)
      continue
    }
    if (method === 'defineProperties') {
      if (mayHold(target) && literalMayName(args[1])) return refuse('define-properties', call)
      continue
    }
    // `defineProperty` (either owner) and `Reflect.set`, whose optional fourth
    // argument is the receiver a data property is created on.
    const receivers = method === 'set' && args[3] ? [target, args[3]] : [target]
    if (receivers.some(mayHold) && keyMayName(args[1])) return refuse(`reflective-${method}`, call)
  }

  // The intrinsics themselves, resolved from the standard library -- a program
  // that shadows `Object` or `Reflect` at the root's own scope proves nothing.
  const intrinsic = (symbolName: string): ts.Type | null => {
    const symbol = checker.resolveName(symbolName, at, ts.SymbolFlags.Value, false)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    return symbol && declaration?.getSourceFile().isDeclarationFile ? checker.getTypeOfSymbolAtLocation(symbol, at) : null
  }
  const objectConstructor = intrinsic('Object')
  const reflect = intrinsic('Reflect')
  const objectPrototype = objectConstructor?.getProperty('prototype')
  if (!objectConstructor || !reflect || !objectPrototype) return refuse('intrinsics-unresolved')
  const isDirectCallee = (reference: ts.MemberName): boolean => {
    const access = reference.parent
    return (
      ts.isPropertyAccessExpression(access) &&
      access.name === reference &&
      ts.isCallExpression(outermostValueWrapperOf(access).parent) &&
      unwrapValueExpression((outermostValueWrapperOf(access).parent as ts.CallExpression).expression) === access
    )
  }
  // `const define = Object.defineProperty; define( o, 0, d )` calls a mutator
  // the scan above never sees as one.
  const mutators = [
    ...OBJECT_PROPERTY_MUTATORS.map((method) => objectConstructor.getProperty(method)),
    ...REFLECT_PROPERTY_MUTATORS.map((method) => reflect.getProperty(method))
  ]
  for (const symbol of mutators) {
    if (!symbol) continue
    for (const reference of flow.memberReferencesToSymbol(symbol)) {
      if (!isDirectCallee(reference)) return refuse('reflective-mutator-escapes', reference)
    }
  }
  /** A value that may be `Object.prototype` is only ever read from or compared. */
  const onlyReadOrCompared = (value: ts.Node): boolean => {
    const use = outermostValueWrapperOf(value)
    const parent = use.parent
    return (
      (ts.isPropertyAccessExpression(parent) && parent.expression === use) ||
      (ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind))
    )
  }
  for (const reference of flow.memberReferencesToSymbol(objectPrototype)) {
    const access = reference.parent
    if (!ts.isPropertyAccessExpression(access) || access.name !== reference || !onlyReadOrCompared(access))
      return refuse('object-prototype-escapes', reference)
  }
  for (const symbol of [objectConstructor.getProperty('getPrototypeOf'), reflect.getProperty('getPrototypeOf')]) {
    if (!symbol) continue
    for (const reference of flow.memberReferencesToSymbol(symbol)) {
      if (!isDirectCallee(reference) || !onlyReadOrCompared(outermostValueWrapperOf(reference.parent).parent))
        return refuse('prototype-read-escapes', reference)
    }
  }
  return true
}

const CLOSED_LITERAL_ABSENCE_LEDGER_SCOPE = 'closed-literal-member-absence'
const publishedClosedLiteralAbsenceRequirements = new WeakMap<
  DeferredIntrinsicProtocolLedger,
  { readonly all: IntrinsicProtocolRequirement[]; readonly seen: Map<ts.Node, Set<string>> }
>()

/**
 * Keep a surviving answer's intrinsic obligations -- `flow/class-family-member-read.ts`'s
 * own `publish` restated for this proof. `ledger.include` only reaches an
 * active `capture` frame, which a binding census's `propertyTypeOf` does not
 * open around this ask (unlike the producer-context hook, which does); without
 * a `capture`-independent path the obligation this proof raises would just be
 * dropped the first time a census asks outside one, and the answer it is
 * attached to would be unsound. `ledger.replace` writes straight into the
 * ledger's persistent scope map, so it works regardless.
 */
const publishClosedLiteralAbsenceRequirements = (
  ledger: DeferredIntrinsicProtocolLedger,
  requirements: readonly IntrinsicProtocolRequirement[]
): void => {
  if (requirements.length === 0) return
  ledger.include(requirements)
  let held = publishedClosedLiteralAbsenceRequirements.get(ledger)
  if (!held) publishedClosedLiteralAbsenceRequirements.set(ledger, (held = { all: [], seen: new Map() }))
  let added = false
  for (const requirement of requirements) {
    let kinds = held.seen.get(requirement.location)
    if (!kinds) held.seen.set(requirement.location, (kinds = new Set()))
    const kind = `${requirement.intrinsic}.${intrinsicProtocolRequirementKind(requirement) ?? ''}`
    if (kinds.has(kind)) continue
    kinds.add(kind)
    held.all.push(requirement)
    added = true
  }
  if (added) ledger.replace(CLOSED_LITERAL_ABSENCE_LEDGER_SCOPE, held.all)
}

/**
 * `undefined`, when a NAMED key is proven absent from a CLOSED object-literal
 * record and nothing in the program can add it -- the same fact
 * `flow/class-family-member-read.ts` states for an absent CLASS key, restated
 * for a record with no class behind it at all.
 *
 * three's `getProgramCacheKey( parameters )` pushes
 * `parameters.morphAttributeCount` into the program's cache-key array.
 * `parameters` is the 135-field literal `getParameters` returns, and
 * `morphAttributeCount` is not one of its fields -- not written anywhere in
 * the file, not anywhere in three's whole source (measured: the only mention
 * is this one read). JavaScript reads an absent own property as `undefined`,
 * falling through to `Object.prototype.morphAttributeCount`, which nothing
 * defines -- so the push is `undefined` on every call, while the checker's own
 * answer for the read (an unknown member of an object type with no index
 * signature) is `any`.
 *
 * `closedObjectLiteralIndexTypeOf` already states this fact for an
 * unresolved KEY read on a closed literal, from the literal's own declared
 * properties alone. A NAMED read commits to one key (`morphAttributeCount`)
 * up front, so unlike an index read it can be wrong about a SPECIFIC name if
 * the literal is handed to code that adds exactly that key through an alias
 * this read never sees syntactically -- which is why this proof also has to
 * survive every write in the program (`closedLiteralMemberAbsent`) rather
 * than stop at the literal's own declaration.
 *
 * The Object obligation is the one `flow/class-family-member-read.ts`
 * publishes for the same reason: the answer depends on `Object.prototype`
 * staying intact for this one key, recorded on the deferred ledger
 * (`requirePrototypeKeys('Object', { names: [name] }, at)`) and discharged
 * against the final host-mutation census, never assumed here.
 */
const absentClosedObjectLiteralMemberTypeOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Type,
  name: string,
  at: ts.Node
): ts.Type | null => {
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (!ledger) {
    if (closedLiteralAbsenceDebug !== undefined) process.stderr.write(`[CLOSED-LITERAL-ABSENCE] ${name} no-ledger\n`)
    return null
  }
  const arms = receiver.isUnion() ? receiver.types : [receiver]
  for (const arm of arms) {
    if (checker.getPropertyOfType(arm, name)) {
      if (closedLiteralAbsenceDebug !== undefined)
        process.stderr.write(`[CLOSED-LITERAL-ABSENCE] ${name} property-found-on-arm ${checker.typeToString(arm)}\n`)
      return null
    }
    let proofsByType = closedLiteralAbsenceProofs.get(flow)
    if (!proofsByType) closedLiteralAbsenceProofs.set(flow, (proofsByType = new WeakMap()))
    let proofs = proofsByType.get(arm)
    if (!proofs) proofsByType.set(arm, (proofs = new Map()))
    let proved = proofs.get(name)
    if (!proved) {
      proved = ledger.capture(() => {
        // The prototype obligation is recorded HERE, not inside the write
        // scan: the scan can refuse for reasons that have nothing to do with
        // `Object.prototype` (a keyed write it cannot rule out), and a
        // refused proof must not still publish an obligation nobody needs.
        if (ledger.requirePrototypeKeys('Object', { names: [name] }, at) !== true) {
          if (closedLiteralAbsenceDebug !== undefined)
            process.stderr.write(`[CLOSED-LITERAL-ABSENCE] ${name} require-prototype-keys-failed\n`)
          return false
        }
        return closedLiteralMemberAbsent(checker, flow, arm, name, at)
      })
      proofs.set(name, proved)
    }
    if (!proved.value) {
      if (closedLiteralAbsenceDebug !== undefined) process.stderr.write(`[CLOSED-LITERAL-ABSENCE] ${name} proof-rejected\n`)
      return null
    }
    // `ledger.include` only reaches an active `capture` frame; a caller that
    // asks this OUTSIDE one (every binding census's `propertyTypeOf`, unlike
    // the producer-context hook which wraps its own ask) would silently lose
    // the obligation right here. Publish it into a persistent scope instead --
    // the same `capture`-independent path `flow/class-family-member-read.ts`'s
    // own `publish` uses for the identical class-family obligation -- so the
    // requirement survives to the final sealed-census discharge regardless of
    // which caller asked first.
    publishClosedLiteralAbsenceRequirements(ledger, proved.requirements)
  }
  return checker.getUndefinedType()
}

/**
 * Whether a NAMED property read is proven to miss every instance of a closed
 * object-literal record -- `numericIndexAbsenceProven`'s counterpart for a
 * named key instead of a numeric one. Deliberately separate from
 * `memberTypeOf`: an `undefined` answer there can also come from an ordinary
 * declared member or an array index signature, neither of which licenses a
 * PRODUCER skipping the runtime property lookup and constant-folding the read
 * -- only THIS proof does, which is why `producers/properties.ts` asks it
 * directly rather than re-deriving "was it the absence arm" from
 * `memberTypeOf`'s result.
 */
export const closedLiteralMemberAbsenceProven = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Type,
  name: string,
  at: ts.Node
): boolean =>
  deferredIntrinsicProtocolLedgerOf(flow) !== null && absentClosedObjectLiteralMemberTypeOf(checker, flow, receiver, name, at) !== null

/**
 * The literal member NAME an element access spells, or `null` when its key is
 * not a literal. `x[ 'name' ]` and `x[ 0 ]` are named reads written with
 * brackets and resolve exactly as `x.name` does.
 */
export const literalMemberNameOf = (node: ts.ElementAccessExpression): string | null => {
  const argument = node.argumentExpression
  if (!argument) return null
  if (ts.isStringLiteralLike(argument)) return argument.text
  if (ts.isNumericLiteral(argument)) return argument.text
  return null
}

/**
 * The one overload of `resolved` whose declared parameter count admits this
 * call's argument count, or `null` when none or several do.
 *
 * Asked only when the checker resolved the call to a signature with NO
 * declaration -- its fabricated any-call, which is what a call through an
 * `any` receiver gets. The RECEIVER here is census-typed (`memberTypeOf` was
 * handed it), so the member's overload set is real and only the checker's own
 * choice among its members is missing. Counting arguments is the checker's own
 * first step (`chooseOverload` discards every candidate the count rules out
 * before comparing one type), so it is the step that can be repeated without
 * the receiver the checker refused to type; a tie keeps the set whole. Three's
 * `LOD.addLevel` is the measured case: `levels` is a descriptor-defined field
 * the checker declares nothing for, and `levels.splice( l, 0, level )` chose
 * the two-parameter overload by joining, so the item reached the emitter
 * unpacked -- `Array.prototype.splice`'s renderer refused it by name.
 */
export const arityAdmittedSignature = (resolved: ts.Type, call: ts.CallExpression): ts.Signature | null => {
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return null
  const count = call.arguments.length
  const admitted = resolved.getCallSignatures().filter((signature) => {
    const declaration = signature.getDeclaration()
    if (!declaration) return false
    const parameters = declaration.parameters
    const last = parameters[parameters.length - 1]
    const rest = last?.dotDotDotToken !== undefined
    const required = parameters.filter(
      (parameter) => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken
    ).length
    return count >= required && (rest || count <= parameters.length)
  })
  const only = admitted[0]
  return admitted.length === 1 && only ? only : null
}

const arityAdmittedDeclaration = (resolved: ts.Type, call: ts.CallExpression): ts.SignatureDeclaration | null =>
  arityAdmittedSignature(resolved, call)?.getDeclaration() ?? null

export const singleConventionAt = (checker: ts.TypeChecker, resolved: ts.Type, node: ts.Node): ts.Type | null => {
  const overloaded = resolved.getCallSignatures().length > 1 || resolved.getConstructSignatures().length > 1
  if (!overloaded) return resolved
  const call = node.parent
  if (!call || !ts.isCallExpression(call) || call.expression !== node) return null
  const declaration = checker.getResolvedSignature(call)?.declaration ?? arityAdmittedDeclaration(resolved, call)
  if (!declaration) return null
  const single = checker.getTypeAtLocation(declaration)
  if ((single.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
  return single.getCallSignatures().length === 1 ? single : null
}

/** The result of an authenticated `.call`/`.apply`, read from its already-resolved underlying callable. */
export const explicitThisCallReturnType = (fallback: ts.Signature, underlying: ts.Type | null): ts.Type => {
  if (!underlying) return fallback.getReturnType()
  const signatures = underlying.getCallSignatures()
  const signature = signatures[0]
  if (signatures.length !== 1 || !signature || signature.typeParameters?.length) return fallback.getReturnType()
  return signature.getReturnType()
}

/**
 * An overload-independent result is knowable even when its physical call
 * convention is not. Read every declared return through the same recovered
 * receiver type; no overload is selected and no callable carrier is changed.
 * Generic signatures remain the checker's instantiation question.
 */
export const overloadInvariantReturnTypeAt = (
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
  read: (node: ts.Expression) => ts.Type | null
): ts.Type | null => {
  const expression = call.expression
  let callee: ts.Type | null
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const receiver = read(expression.expression)
    const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : literalMemberNameOf(expression)
    if (!receiver || name === null) return null
    // memberTypeOf also asks for a single convention. This query only asks
    // what all conventions return, so retain the complete member type.
    const member = checker.getPropertyOfType(checker.getNonNullableType(receiver), name)
    callee = member ? checker.getTypeOfSymbolAtLocation(member, expression) : null
  } else {
    callee = read(expression)
  }
  if (!callee) return null
  const signatures = ts.isNewExpression(call) ? callee.getConstructSignatures() : callee.getCallSignatures()
  if (signatures.length < 2 || signatures.some((signature) => signature.typeParameters?.length)) return null
  const returned = signatures[0]?.getReturnType()
  if (!returned || isUnusableEvidence(returned)) return null
  return signatures.every((signature) => signature.getReturnType() === returned) ? returned : null
}

/** Whether `node` (through any parentheses) is the expression a call or `new` invokes. */
const calleePosition = (node: ts.Node): boolean => {
  let current: ts.Node = node
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent
  const parent = current.parent
  return parent !== undefined && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === current
}

export const memberTypeOf = (
  checker: ts.TypeChecker,
  receiver: ts.Type,
  name: string,
  at: ts.Node,
  flow?: ValueFlowIndex
): ts.Type | null => {
  const nonNullReceiver = checker.getNonNullableType(receiver)
  const property = checker.getPropertyOfType(nonNullReceiver, name)
  if (!property) {
    // Array index signatures also govern literal keys. An array has no own
    // declared "0" member, unlike a tuple; treating that absence as silence
    // loses an element already recovered from the receiver's storage.
    if (checker.isArrayLikeType(nonNullReceiver) && String(Number(name)) === name) {
      const element = checker.getIndexTypeOfType(nonNullReceiver, ts.IndexKind.Number)
      return element && !isUnusableEvidence(element) ? checker.getNullableType(element, ts.TypeFlags.Undefined) : null
    }
    // JavaScript reads an absent own property as `undefined`. When the
    // receiver is proven a CLOSED object-literal record that nothing in the
    // program can add `name` to, that really is the read's value -- see
    // `absentClosedObjectLiteralMemberTypeOf`'s own header for why this is
    // answered here (the one shared authority every binding census's
    // `propertyTypeOf` already routes through) rather than once per census.
    //
    // Never for a CALLEE. `undefined` is the read's value; calling it is a
    // guaranteed TypeError, and a callee slot typed `undefined` is not a
    // refusal, it is a program the lowering has to invent a meaning for.
    // `test/runtime/borrowed-array-method-unmatched-receiver.runtime.js`
    // is the measured case: `borrowed-builtin-call-bind-source-transform.ts`
    // rewrites `Array.prototype.join.call( o, ',' )` into `o.join( ',' )`, a
    // read the ORIGINAL program never performs, on a literal that proves
    // `join` absent. Answered as absent, the site was refused only by the
    // host-mutation census happening to read the same call as a possible
    // `Object.prototype.join` mutator -- a circular refusal that names the
    // wrong thing. Left unanswered, the callee falls through to the record
    // member get, which refuses by name (`"Array.prototype.join" has no
    // rendering off a "record(...)"`), exactly as before absence existed.
    return flow && !calleePosition(at) ? absentClosedObjectLiteralMemberTypeOf(checker, flow, nonNullReceiver, name, at) : null
  }
  const type = checker.getTypeOfSymbolAtLocation(property, at)
  if (isUnusableEvidence(type)) return null
  return singleConventionAt(checker, type, at)
}

/**
 * Whether a JSDoc tag resolved to nothing AT ALL -- `any` or `unknown`.
 *
 * Not the whole question a cell has; see `jsDocTypeStatesNothing`, which is
 * what every cell should ask. This is only the arm that is specific to a TAG:
 * a tag naming a type this module cannot import degrades to `any`. A tag
 * that SPELLS `unknown` (`{unknown}`, `{?}`) is not that degradation -- it is
 * the author's own statement, exactly as a real `unknown` annotation is
 * (`annotationStatesNothing`), and is answered `false` below so the two
 * spellings of one statement get one census answer.
 */
export const jsDocTypeIsUninformative = (checker: ts.TypeChecker, typeNode: ts.TypeNode): boolean => {
  // A SPELLED `{unknown}` (or its JSDoc form `{?}`) is the author writing
  // the statement a TS `: unknown` annotation makes, and stays one: a name
  // that fails to resolve degrades to `any`, never to `unknown`, so this
  // spelling cannot be the degradation this exists to admit. Measured the
  // other way on test262's own harness compiled as JavaScript: `@param
  // {unknown} actual` on `assert.sameValue` was admitted, the call sites
  // bound the slot `number`, and the body -- laid out from the checker's
  // `unknown` -- declared the same parameter dynamic, so the ABI and the
  // frame disagreed and every case using the shim refused. `{any}`/`{*}`
  // stay admitted: three.js writes `{any}` 31 times on parameters the three.js app
  // measures as call-site-bindable, and that tag IS indistinguishable in
  // resolved type from a degraded name.
  if (typeNode.kind === ts.SyntaxKind.UnknownKeyword || typeNode.kind === ts.SyntaxKind.JSDocUnknownType) return false
  const resolved = checker.getTypeFromTypeNode(typeNode)
  return (resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
}

/**
 * Whether a JSDoc tag states nothing about storage -- the ONE test every cell
 * asks of a tag, tag-specific degradation plus the identical vacuity rule a
 * real annotation gets.
 *
 * Four cells asked this and each asked it differently:
 * `parameter-bindings.ts` had a private copy that added `isEmptyObjectType`,
 * while `return-bindings.ts`, `field-bindings.ts` and `local-bindings.ts`
 * asked `jsDocTypeIsUninformative` alone -- so a `@param {{}}` tag was
 * non-evidence at one cell and a stated type at the other three. Ordinary
 * drift, of the shape this compiler keeps finding.
 *
 * The measured hole all four shared is `{Object}`. Three separate comments in
 * this file asserted that TypeScript's JSDoc parser maps a capitalized
 * `{Object}` tag to `any`, so `jsDocTypeIsUninformative` would catch it and
 * `isGlobalObjectInterface` was documented as "not reachable from JSDoc".
 * That is false, measured on three's `UniformsUtils.js`:
 *
 *     &#64;return {Object} The cloned uniforms.
 *     export function cloneUniforms( src ) { const dst = {}; ... return dst }
 *
 * `getReturnTypeOfSignature` answers the REAL `lib.es5.d.ts` `Object`
 * interface -- 7 properties, `TypeFlags.Object`, not `any` and not empty. So
 * it passed every vacuity test, became the return cell's stated answer, and
 * the honest `dictionary` the body builds had to convert to a named record
 * with zero members (every one of `Object`'s members is an ambient method
 * `structural.ts` drops). No backend can render that pair, and the whole
 * uniforms chain downstream of it -- `parameters.uniforms`,
 * `materialProperties.uniforms`, and the 338 boxed carriers of
 * `WebGLMaterials.js`'s `refreshUniforms*( uniforms, material )` -- was
 * dynamic because of one tag.
 *
 * Recording that premise as false is the finding; making the tag path REFUSE
 * an `{Object}` is not the cure, and the inline comment below carries the
 * measurement that rules it out.
 */
export const jsDocTypeStatesNothing = (checker: ts.TypeChecker, typeNode: ts.TypeNode): boolean =>
  // The parameter census's own private copy of this test, made shared: three
  // cells asked only `jsDocTypeIsUninformative`, one asked that OR
  // `isEmptyObjectType`, and a tag is one question, so they answer with one
  // authority now.
  //
  // Deliberately NOT `annotationStatesNothing`: that also refuses a tag
  // resolving to the global `Object` interface. Adding that arm was measured on
  // the three.js app and is a DEAD LEVER -- boxedTop stayed at exactly 9431, boxed rose
  // 15899 -> 15906, and `withheld` went 8 -> 39, taking 134 operations with it
  // (the 31 new ones sit on `mergeUniforms`/`cloneUniforms` results cited by
  // object literals: ShaderLib 20, WebGLBackground 8, plus ShaderMaterial,
  // Object3D and WebGLEnvironments). The carrier does not change because refusing
  // the tag only makes the census decline, after which the CHECKER hands the
  // very same named-empty `Object` record to the signature -- so the two
  // authorities on one call's result stop agreeing while the boxing stays put.
  // Do not retry it here. `@return {Object}` DOES reach a cell and resolve to
  // the real 7-member `lib.es5` interface (three comments in this file once
  // claimed the JSDoc parser maps it to `any` -- it does not, they are
  // corrected), but the fix has to change what that interface DERIVES to, not
  // whether a census reads it.
  jsDocTypeIsUninformative(checker, typeNode) || isEmptyObjectType(checker.getTypeFromTypeNode(typeNode))

/**
 * Whether a resolved type is a structural object type with ZERO evidence in
 * it: no properties, no call signature, no construct signature, no index
 * signature.
 *
 * Lived in `parameter-bindings.ts` until `return-bindings.ts` needed the same
 * question; moved here -- the module both already share for
 * `jsDocTypeIsUninformative` and `widestOf` -- rather than copied, so the two
 * cannot drift.
 *
 * `jsDocTypeIsUninformative` above catches a tag that resolves to
 * `any`/`unknown` -- an unimported cross-module name, or the JSDoc-special
 * `Object`/`object`. It does NOT catch this: three writes `@param {Object}
 * data` for `InterleavedBuffer.clone( data )`, and
 * `declaration-overlay-transform.ts`'s `replaceVagueParamTags` correctly
 * prefers the SHIPPED declaration's answer over that vague tag -- but the
 * shipped declaration (`@types/three`) states `clone(data: {}): ...`, and
 * `{}` is itself a type with nothing IN it. The overlay's replacement is a
 * real improvement in the general case (`Material.fromJSON`'s `json` gets a
 * real `MaterialJSON`); here it swaps one uninformative spelling for another,
 * and without this check the resolved `{}` reads as "the program stated a
 * real type" and stays excluded from the call-site census forever, even
 * though it states precisely as much as `any` does about what the parameter
 * holds.
 *
 * The same non-evidence `parameter-bindings.ts`'s `isBareFunctionType`
 * already is for a type with zero CALLING convention, generalized to zero
 * MEMBER convention.
 */
export const isEmptyObjectType = (type: ts.Type): boolean => {
  // The bare `object` KEYWORD (lowercase, `TypeFlags.NonPrimitive`) is a
  // structural type distinct from `ts.TypeFlags.Object` -- it is TypeScript's
  // own "some non-primitive value, shape unstated" wildcard, so it declares
  // no properties/signatures by construction and states nothing about
  // storage for the identical reason an empty `{}` type literal does. Caught
  // here rather than folded into `jsDocTypeIsUninformative`: lowercase
  // `object` resolves to this REAL, non-`any`/`unknown` type (and so, it
  // turns out, does capitalized `Object` -- see `isGlobalObjectInterface`,
  // which handles that one) -- `WebGLProgram`'s own
  // `@param {object} parameters` (matching what `@types/three` itself
  // declares: `constructor(..., parameters: object)`) reads as "the program
  // stated a real type" without this check, even though `object` carries
  // exactly as little information as `any` does for what can be read off it.
  if ((type.flags & ts.TypeFlags.NonPrimitive) !== 0) return true
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (type.getProperties().length > 0) return false
  if (type.getCallSignatures().length > 0) return false
  if (type.getConstructSignatures().length > 0) return false
  return !type.getStringIndexType() && !type.getNumberIndexType()
}

/**
 * Whether a type has no NAME of its own -- the `object` keyword, or an
 * anonymous `{}` type literal, as opposed to a declared interface that
 * happens to have no members.
 *
 * This distinction does not arise on the JSDoc path and is what makes
 * `annotationStatesNothing` below narrower than `isEmptyObjectType`. Measured
 * over the three.js app's whole program: 168 of the 197 parameter annotations that
 * `isEmptyObjectType` alone calls empty are NAMED, and they are `lib.dom`'s
 * opaque handle interfaces -- `interface WebGLProgram {}`, `WebGLBuffer`,
 * `WebGLShader`, `PeriodicWave`, `FragmentDirective`. Those are declared
 * empty on purpose: emptiness IS the statement, a nominal handle nobody may
 * read a member off. Re-deriving one of them from its call sites would
 * replace a nominal identity the host owns with whatever this compiler's own
 * join happened to pick, so a named type keeps outranking the census here
 * even when it is structurally empty.
 */
const isAnonymousType = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.NonPrimitive) !== 0) return true
  const name = type.getSymbol()?.getName()
  return name === undefined || name === '__type' || name === '__object'
}

/**
 * The checker's own answer for a standard-library INTERFACE name, resolved at
 * `anchor` and memoized per checker -- so a name a large program's walk asks
 * about at every write site (`Object`, `Map`, ...) is resolved once rather
 * than once per site.
 *
 * `checker.resolveName` is the public API for exactly "what does this name
 * mean here", independent of any use site -- the mechanism `host-protocols.ts`
 * already uses to name `Promise`/`Date`/`String`/the four keyed collections.
 * This shares that same first step. Where it deliberately does NOT follow
 * `host-protocols.ts` is the second: those functions take
 * `identities.symbolDeclarationId(...)` and key a `Map<DeclarationId, ...>`
 * with it, because they publish an answer for OTHER layers to read back
 * across specialization copies. Every caller here asks a one-off "is this
 * type THAT ambient interface" and keys nothing -- and an ambient library
 * interface has exactly one `ts.Symbol` per checker for every INSTANTIATION
 * of that same generic declaration (`Map<string, number>`'s own `getSymbol()`
 * answers the same object bare `Map` does), so comparing that symbol
 * directly states the identical fact `symbolDeclarationId` equality would
 * for that question, without needing an `IdentityTable` this layer does not
 * otherwise hold.
 *
 * What raw symbol equality does NOT state, and `symbolDeclarationId`
 * equality would not either: whether some OTHER type derives from the
 * standard interface rather than being it directly. `class Registry extends
 * Map<string, number> {}` has its own `Registry` symbol, distinct from
 * `Map`'s; `<T extends Map<string, number>>` has its own per-declaration
 * type-parameter symbol. `isStandardInterfaceType(checker, anchor, 'Map',
 * receiverType)` answers `false` for both, correctly by its own question
 * ("IS this type the standard interface") but not by the question a
 * receiver-identity check usually means to ask ("is this a Map"). A caller
 * that means the second question -- `flow/value-flow.ts`'s
 * `matchesStandardInterfaceTransitively` is the one that does -- must take
 * `checker.getApparentType` (to resolve a type parameter to its constraint)
 * and walk `checker.getBaseTypes` transitively (to resolve a subclass to
 * what it extends) itself; this function is one ingredient of that
 * question, not the whole answer to it.
 */
const standardInterfaceSymbolCache = new WeakMap<ts.TypeChecker, Map<string, ts.Symbol | null>>()
const standardInterfaceSymbol = (checker: ts.TypeChecker, anchor: ts.Node, name: string): ts.Symbol | null => {
  let cache = standardInterfaceSymbolCache.get(checker)
  if (!cache) {
    cache = new Map()
    standardInterfaceSymbolCache.set(checker, cache)
  }
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const resolved = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false) ?? null
  cache.set(name, resolved)
  return resolved
}

/**
 * Whether `type` IS the standard library's `name` interface -- by declaration
 * identity, never by the symbol's own spelling. See `standardInterfaceSymbol`.
 */
export const isStandardInterfaceType = (checker: ts.TypeChecker, anchor: ts.Node, name: string, type: ts.Type): boolean => {
  const symbol = type.getSymbol()
  return symbol !== undefined && symbol === standardInterfaceSymbol(checker, anchor, name)
}

/**
 * Whether a type is the global `Object` INTERFACE -- `x: Object`, spelled as a
 * real TypeScript annotation.
 *
 * The exact argument `parameter-bindings.ts`'s `isBareFunctionType` makes for
 * bare `Function`, one level up: `Object` declares only what every value
 * already has (`toString`, `valueOf`, `hasOwnProperty`), every non-null value
 * is assignable to it, and it therefore states nothing about what this
 * particular value holds. Resolved by DECLARATION IDENTITY (`isStandardInterfaceType`),
 * so a user interface that merely declares those members -- and would once
 * have matched on the bare spelling `'Object'` -- is not swept in beside it;
 * only the library's own `Object` is.
 *
 * Reachable from JSDoc TOO, contrary to what this comment said for a long
 * time. A capitalized `{Object}` tag does NOT degrade to `any`: measured on
 * three's `@return {Object}`, the checker answers this very interface. See
 * `jsDocTypeStatesNothing`, which is what makes the tag path ask.
 *
 * `normalize/structural.ts` interns exactly THIS interface as `any`, and the
 * two obvious companions to it are measured DEAD LEVERS, recorded here so the
 * next session does not re-derive them:
 *
 * - an anonymous `{}` (empty, no signatures, no index, excluding fresh object
 *   literals, which share the identical type and are real values whose shape
 *   the object-bag and collection censuses discover): the three.js app's unmet
 *   obligations went 33 UP to 34 and `boxed` 17190 -> 17568. `{}` is the
 *   checker's answer for a great many things that are not "unstated" at all --
 *   an intersection reduced to nothing, a mapped type over no keys, a bag
 *   before its census runs -- and boxing all of them costs more pairings than
 *   it closes.
 * - the lowercase `object` KEYWORD (`TypeFlags.NonPrimitive`), which really is
 *   one unambiguous spelling and really does state nothing: exactly NEUTRAL on
 *   unmet obligations (33 -> 33) at `boxed` +103. A cost with no return.
 *
 * Both remain correct as statements about what those types SAY. Neither is
 * worth what it costs as a carrier decision.
 */
export const isGlobalObjectInterface = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
  return isStandardInterfaceType(checker, anchor, 'Object', type)
}

/**
 * Whether `type` is the standard library's `ObjectConstructor` interface --
 * the type the global `Object` VALUE has, as opposed to `isGlobalObjectInterface`'s
 * `Object` INSTANCE interface immediately above.
 *
 * Exported so the two call sites that ask "is this call really `Object.assign`
 * on the real global" (`flow/value-flow.ts`'s `isGlobalObjectAssign`,
 * `object-bag-bindings.ts`'s `isGlobalObjectAssignCall`) ask one shared
 * question instead of two byte-for-byte-identical copies of it, each
 * comparing `checker.getTypeAtLocation(callee.expression).getSymbol()?.getName()`
 * against the literal string `'ObjectConstructor'`.
 */
export const isGlobalObjectConstructor = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean =>
  isStandardInterfaceType(checker, anchor, 'ObjectConstructor', type)

/** The standard global Function constructor value, by ambient declaration identity. */
export const isGlobalFunctionConstructor = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean =>
  isStandardInterfaceType(checker, anchor, 'FunctionConstructor', type)

/** The standard global Array constructor value, by ambient declaration identity. */
export const isGlobalArrayConstructor = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean =>
  isStandardInterfaceType(checker, anchor, 'ArrayConstructor', type)

/** A standard global namespace value, resolved by symbol identity rather than spelling. */
export const isStandardGlobalValue = (checker: ts.TypeChecker, expression: ts.Expression, name: string): boolean => {
  let actual = checker.getSymbolAtLocation(expression)
  if (actual && (actual.flags & ts.SymbolFlags.Alias) !== 0) actual = checker.getAliasedSymbol(actual)
  let expected = checker.resolveName(name, expression, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false)
  if (expected && (expected.flags & ts.SymbolFlags.Alias) !== 0) expected = checker.getAliasedSymbol(expected)
  return actual !== undefined && expected !== undefined && actual === expected
}

/**
 * The target type of an authenticated `Object.assign` call with at least one source.
 *
 * The ambient signature's `T & U` result describes which properties source
 * code may read after the copy. The runtime value is still `T`: ECMA-262
 * mutates and returns the first argument. Every binding census has to read
 * that identity the same way, or one census publishes the intersection while
 * the invocation producer publishes the target and creates a conversion
 * between two carriers for one object. The extra keys live in the native
 * target's dynamic-property sidecar; changing the value's carrier is neither
 * necessary nor correct.
 *
 * A primitive target is excluded because Object.assign first boxes it, and
 * this backend does not implement wrapper-object carriers.
 */
export const objectAssignTargetType = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!isAuthenticatedObjectAssign(checker, node)) return null
  const target = node.arguments[0]
  if (!target) return null
  const fresh = ts.isObjectLiteralExpression(target) ? objectAssignFreshTargetType(checker, target) : null
  if (fresh !== null) return fresh
  const type = checker.getTypeAtLocation(target)
  return (type.flags & ts.TypeFlags.Object) !== 0 ? type : null
}

/** `Object.assign(...)` on the real global with at least one source, resolved by declaration identity. */
const isAuthenticatedObjectAssign = (checker: ts.TypeChecker, node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node) || node.arguments.length < 2) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'assign') return false
  return isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression))
}

/**
 * The object `Object.assign( {}, ...sources )` builds, when `literal` is that
 * bare `{}`.
 *
 * `objectAssignTargetType`'s identity argument holds for a target that exists
 * before the call: the value returned IS that object, so its carrier is that
 * object's own, extra keys in the sidecar. A bare empty literal written in the
 * target position has no carrier of its own to keep. It is allocated for this
 * call, observed nowhere else, and the one statement anywhere of what it holds
 * afterwards is the call's own `T & U` -- which the checker has already
 * reduced, dropping the empty member (`{} & Record<string, number[]>` reports
 * as `Record<string, number[]>`). Publishing the literal's own `{}` in its
 * place put an empty record on one side of the copy and a dictionary on the
 * other: three's `Object.assign( {}, source.defines )` then refused for want of
 * a record<-dictionary arm, and no such arm can exist, since an empty struct
 * has nowhere to put a key.
 *
 * Read by BOTH the call's result (`objectAssignTargetType`) and the literal's
 * own layout (`structural-layout-type.ts`), so the target and the value it
 * becomes are one carrier by construction. A literal with properties keeps its
 * own shape -- it states one -- and so does a literal under an assertion.
 */
export const objectAssignFreshTargetType = (checker: ts.TypeChecker, literal: ts.ObjectLiteralExpression): ts.Type | null => {
  if (literal.properties.length !== 0) return null
  const call = literal.parent
  if (!isAuthenticatedObjectAssign(checker, call) || call.arguments[0] !== literal) return null
  const type = checker.getTypeAtLocation(call)
  return (type.flags & ts.TypeFlags.Object) !== 0 ? type : null
}

/**
 * Whether a REAL TypeScript type ANNOTATION states nothing -- the same
 * non-statement `jsDocTypeStatesNothing` already recognises in a JSDoc tag,
 * asked of a type the program wrote out in TypeScript.
 *
 * `getExtension( name: string ): object | null`, `f( options: {} )`, `g( x:
 * Object )`: each is exactly as informative about storage as the JSDoc
 * `@param {Object}` tag that commit `f6c90e4b4` stopped trusting, and for the
 * same reason -- a stated type that resolves to something which says nothing
 * is WORSE than no type at all, because it becomes the answer and outranks a
 * census that could have derived a real one.
 *
 * Deliberately NOT widened past that:
 *
 * - `unknown` is a statement. An author who writes `unknown` is saying "do not
 *   assume", and that must keep outranking anything this compiler infers.
 * - a NAMED empty type is a statement -- see `isAnonymousType`.
 * - a non-empty interface is a statement, however loose.
 * - `any` written out as a real annotation is left exactly where it is. It is
 *   a separate lever with a separate blast radius, and this module's
 *   `resolvedReturnTypeOf` already documents honouring `: any` at face value.
 *
 * A union is seen through only when its non-absent half is itself a
 * non-statement: `object | null` states as little as `object` does, since
 * `null` is not a shape. Any other union member is real evidence and stops
 * this.
 *
 * `checker`/`anchor` exist only for `isGlobalObjectInterface`'s declaration-identity
 * resolution (`isStandardInterfaceType`) -- `anchor` is any node reachable
 * from the site this type came from; a REAL `Object` is a single ambient
 * global, so which node names it does not change the answer.
 */
/**
 * The one test for "this PART of a type says nothing about storage" -- bare
 * `{}` (anonymous and empty) or the global `Object` interface.
 *
 * Shared so `annotationStatesNothing` (is the WHOLE thing a non-statement?)
 * and `withoutVacuousMembers` (which PARTS of it are) cannot drift apart:
 * they are the same question asked of a type and of its members, and a join
 * that trusts one while the other disagrees is exactly the bug both exist to
 * prevent.
 */
const statesNothingPart = (checker: ts.TypeChecker, anchor: ts.Node | null, part: ts.Type): boolean =>
  (isEmptyObjectType(part) && isAnonymousType(part)) || (anchor !== null && isGlobalObjectInterface(checker, anchor, part))

/**
 * `statesNothingPart` asked THROUGH a constraint, for a part that is not
 * itself a type at all but a stand-in for one.
 *
 * `E['Bindings']`, where hono declares `type Bindings = object` and
 * `E extends Env`, is a deferred indexed access: not an object type, so
 * neither arm of `statesNothingPart` sees it, and yet the checker relates
 * every object type to it exactly as it does to `object` -- through that
 * constraint. It carries as little as `object` does (this compiler derives it
 * to `dynamic`), and a join that treats it as a real statement lets it cover
 * observations it says nothing about, which is the whole defect the veto
 * exists to stop.
 *
 * Kept OUT of `annotationStatesNothing`, deliberately: that function decides
 * whether a stated type is evidence at all, and a constraint-following
 * version of it would demote every `T extends object` annotation in every
 * census at once. This one is read only by `withoutVacuousMembers`, whose
 * single caller uses it to RE-ASK a coverage question it has already been
 * given an answer to -- so a wrong answer here can only refuse a join, never
 * narrow a slot.
 *
 * A constraint that is a union is vacuous only when its every non-absent
 * member is -- the same shape, and the same reason, as the union arm of
 * `annotationStatesNothing` itself.
 */
const statesNothingThroughConstraint = (checker: ts.TypeChecker, anchor: ts.Node | null, part: ts.Type): boolean => {
  if (statesNothingPart(checker, anchor, part)) return true
  const constraint = checker.getBaseConstraintOfType(part)
  if (constraint === undefined || constraint === part) return false
  const absent = ts.TypeFlags.Null | ts.TypeFlags.Undefined
  let sawStatement = false
  for (const member of constraint.isUnion() ? constraint.types : [constraint]) {
    if ((member.flags & absent) !== 0) continue
    if (!statesNothingPart(checker, anchor, member)) return false
    sawStatement = true
  }
  return sawStatement
}

/**
 * `type` with every vacuous member dropped, or `null` when nothing is left.
 *
 * `annotationStatesNothing` answers "is this type ENTIRELY a non-statement",
 * which is the right question for evidence: a type that says nothing must not
 * become the answer. It is the wrong question for a JOIN with a vacuous
 * member ALONGSIDE a real one -- `{} | E['Bindings'] | undefined`, the first
 * element of the tuple TypeScript gives hono's `fetch(request, ...rest)`.
 * That type is not entirely vacuous (the indexed access is a statement), yet
 * the `{}` inside it still makes EVERY object type assignable to the whole,
 * so a `widestOf` join hands it back as "the" type and the other elements --
 * `ExecutionContext` -- vanish without a trace.
 *
 * The caller's use is a re-test, never an answer: strip the vacuous parts and
 * ask whether the coverage survives. If it does, the join was real; if it
 * does not, the coverage was `{}`'s alone and the join has to state the union
 * instead. Nothing published to representation is ever the stripped type --
 * that would be the opposite error, narrowing a slot below what the program
 * annotated.
 */
export const withoutVacuousMembers = (checker: ts.TypeChecker, anchor: ts.Node | null, type: ts.Type): ts.Type | null => {
  const parts = type.isUnion() ? type.types : [type]
  // `isGlobalObjectInterface` resolves the NAME `Object` somewhere in the
  // program to compare declaration identity, and any node in it answers that
  // the same way (a real `Object` is a single ambient global). A caller with
  // no node in hand -- `widestOf`, which is handed types alone -- gets one
  // from the type itself rather than losing that arm of the test.
  const at = anchor ?? parts.flatMap((part) => part.getSymbol()?.getDeclarations() ?? [])[0] ?? null
  const kept = parts.filter((part) => !statesNothingThroughConstraint(checker, at, part))
  if (kept.length === parts.length) return type
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(kept) : null
}

export const annotationStatesNothing = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean => {
  const bare = (part: ts.Type): boolean => statesNothingPart(checker, anchor, part)
  if (bare(type)) return true
  if (!type.isUnion()) return false
  const absent = ts.TypeFlags.Null | ts.TypeFlags.Undefined
  let sawNonStatement = false
  for (const part of type.types) {
    if ((part.flags & absent) !== 0) continue
    if (!bare(part)) return false
    sawNonStatement = true
  }
  return sawNonStatement
}

/**
 * The exact type of an EMPTY object literal the program wrote as a value --
 * `{}` in `const { fn = function () {} } = {}` -- or `null` for any other node.
 *
 * `annotationStatesNothing` above is right to treat the vacuous type `{}` as
 * a non-statement when it arrives as an ANNOTATION or as a join member: every
 * type is assignable to it, so it dominates. The same type on a literal the
 * program EVALUATES is the opposite: a fresh object with exactly zero members,
 * the most precise statement there is, and the one a destructuring pattern
 * reads out of. Filtering it out there left every pattern over `{}` with no
 * holder at all, so each leaf fell back to the checker's own `any` (the JS
 * checker's answer for a key the literal lacks) and boxed the default it was
 * meant to bind. A literal with spreads or properties is not this case: the
 * ordinary literal type is already non-vacuous and needs no exception.
 */
export const exactEmptyObjectLiteralType = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null =>
  ts.isObjectLiteralExpression(node) && node.properties.length === 0 ? checker.getTypeAtLocation(node) : null

/**
 * A position the DECLARATION states nothing about.
 *
 * `annotationStatesNothing` above answers this for a WHOLE annotation -- `x:
 * {}`, `x: object`. This is the same question asked of one position INSIDE
 * one: `any` and `unknown` are the checker's two spellings of "no statement
 * about this value", and bare `Function` is the third (see
 * `parameter-bindings.ts`'s `isBareFunctionType` -- zero call signatures,
 * zero construct signatures, so no arity and no result either).
 */
const positionStatesNothing = (checker: ts.TypeChecker, anchor: ts.Node, declared: ts.Type): boolean => {
  if ((declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
  if (annotationStatesNothing(checker, anchor, declared)) return true
  if (declared.getCallSignatures().length > 0 || declared.getConstructSignatures().length > 0) return false
  return declared.getSymbol()?.getName() === 'Function'
}

/**
 * Whether a stated type has an unstated position ANYWHERE inside it, and so
 * could be an upper bound rather than the last word.
 *
 * A pre-filter, not a judgement: `narrowsOnlyUnstatedPositions` below decides
 * whether a particular value may narrow a particular statement. This only
 * keeps a census from carrying every annotated declaration in the program as
 * a candidate when almost none of them state nothing anywhere.
 */
export const containsUnstatedPosition = (checker: ts.TypeChecker, anchor: ts.Node, declared: ts.Type, depth = 0): boolean => {
  if (depth > 8) return false
  if (positionStatesNothing(checker, anchor, declared)) return true
  // `Iterable<T>` states the values iteration yields and deliberately does
  // not state what physical object implements the protocol. A concrete Array,
  // Set, generator or user iterator returned through that annotation must keep
  // its own carrier; flattening the interface into a record invents an object
  // layout for a protocol view. Treat the implementation position as unstated
  // while `narrowsOnlyUnstatedPositions` below still requires the concrete
  // type to satisfy this exact standard-library declaration, including `T`.
  if (isStandardInterfaceType(checker, anchor, 'Iterable', declared)) return true
  if (declared.isUnion() || declared.isIntersection()) {
    return declared.types.some((part) => containsUnstatedPosition(checker, anchor, part, depth + 1))
  }
  if ((declared.flags & ts.TypeFlags.Object) === 0) return false
  const reference = declared as ts.TypeReference
  if (reference.target === undefined) return false
  return checker.getTypeArguments(reference).some((part) => containsUnstatedPosition(checker, anchor, part, depth + 1))
}

/**
 * WHETHER A STATED TYPE AND THE TYPE THAT ACTUALLY FLOWS INTO IT DIFFER ONLY
 * WHERE THE STATEMENT SAID NOTHING.
 *
 * `annotationStatesNothing` is all-or-nothing about one annotation, which is
 * the right question for a parameter written `: {}` and the wrong one for
 * hono's `matchResult: Result<[unknown, RouterRoute]>`. That annotation states
 * plenty -- a two-armed union of tuples of arrays of tuples -- and states
 * NOTHING at exactly one leaf, the `unknown` where the handler goes. The
 * program's only writer hands it `Result<[H, RouterRoute]>`, identical
 * everywhere the annotation spoke and concrete at the one place it did not.
 *
 * Reading the annotation as the last word there is what forces a value that is
 * already exactly right to be rebuilt into a boxed copy of itself -- through
 * two arrays and three records, which is not a conversion any backend can
 * render soundly (an array rebuild is a COPY, and a copy is not the array the
 * caller passed). Reading it as an upper bound instead, satisfied at every
 * position it constrains, is what lets the value stay itself.
 *
 * This is deliberately NOT "the actual type is assignable to the declared
 * one". Assignability admits a narrowing at a position the program DID state
 * -- `x: string | number` fed only strings -- and honoring the statement is
 * this compiler's rule everywhere else. `checker.isTypeAssignableTo` is still
 * required (the caller asks it), but it is the floor, not the test.
 */
export const narrowsOnlyUnstatedPositions = (
  checker: ts.TypeChecker,
  anchor: ts.Node,
  declared: ts.Type,
  actual: ts.Type,
  depth = 0
): boolean => {
  if (declared === actual) return true
  if (depth > 8) return false
  // A statement of nothing accepts anything CONCRETE. `any` on the actual side
  // is the absence these censuses exist to fill, never an answer to propagate.
  if (positionStatesNothing(checker, anchor, declared)) return (actual.flags & ts.TypeFlags.Any) === 0
  // The implementation half of the `Iterable<T>` upper bound described in
  // `containsUnstatedPosition`: assignability is the checker's proof that the
  // actual object implements this precise protocol and yields the declared
  // element. The concrete carrier is therefore strictly more informative at
  // the one position the annotation leaves open.
  if (isStandardInterfaceType(checker, anchor, 'Iterable', declared)) {
    return (actual.flags & ts.TypeFlags.Any) === 0 && checker.isTypeAssignableTo(actual, declared)
  }
  // Two spellings of one type -- an alias and its expansion, `Params` and
  // `Record<string, string>` -- state the identical thing at every position.
  if (checker.isTypeAssignableTo(actual, declared) && checker.isTypeAssignableTo(declared, actual)) return true
  const declaredReference = declared as ts.TypeReference
  const actualReference = actual as ts.TypeReference
  if (
    (declared.flags & ts.TypeFlags.Object) !== 0 &&
    (actual.flags & ts.TypeFlags.Object) !== 0 &&
    declaredReference.target !== undefined &&
    declaredReference.target === actualReference.target
  ) {
    const left = checker.getTypeArguments(declaredReference)
    const right = checker.getTypeArguments(actualReference)
    if (left.length === 0 || left.length !== right.length) return false
    return left.every((part, index) => {
      const other = right[index]
      return other !== undefined && narrowsOnlyUnstatedPositions(checker, anchor, part, other, depth + 1)
    })
  }
  // A union member that states its whole carrier is not an open position.
  // Preserve every such member before allowing call-site evidence to refine
  // the members that do contain `any`/`unknown`. Otherwise one open arm makes
  // the whole union look open: `string | ArrayBuffer | ReadableStream<unknown>`
  // observed at an incomplete indirect call as only `ReadableStream` dropped
  // the two fully stated body arms, and generated Response construction then
  // read a string as the stream arm. Hono's `Result<[unknown, Route]>` remains
  // refinable because each member's differing position is itself unstated.
  if (declared.isUnion()) {
    const actualMembers = actual.isUnion() ? actual.types : [actual]
    for (const member of declared.types) {
      if (containsUnstatedPosition(checker, anchor, member, depth + 1)) continue
      const preserved = actualMembers.some(
        (candidate) => checker.isTypeAssignableTo(candidate, member) && checker.isTypeAssignableTo(member, candidate)
      )
      if (!preserved) return false
    }
  }
  // A union is matched member-to-member, and NOT as a bijection: `A | B` both
  // narrowing the same declared member is still a narrowing only at unstated
  // positions, which is the whole claim. What is refused is an actual member
  // no declared member covers -- that one is a widening the statement forbids.
  if (declared.isUnion() && actual.isUnion()) {
    return actual.types.every((member) =>
      declared.types.some((candidate) => narrowsOnlyUnstatedPositions(checker, anchor, candidate, member, depth + 1))
    )
  }
  if (declared.isUnion()) {
    return declared.types.some((candidate) => narrowsOnlyUnstatedPositions(checker, anchor, candidate, actual, depth + 1))
  }
  return false
}

/**
 * `T | undefined` -> `T`, and ONLY the `undefined` member: a `null` member is
 * a different absence value and stays.
 *
 * Needed where a cell's contents and a READ of that cell disagree about an
 * absence the language already resolved -- a DEFAULTED parameter, whose slot
 * carries `undefined` (that is what the default exists to answer) and whose
 * body binding cannot: `producers/bindings.ts`'s `contributeDefaultedParameter`
 * strips it there from the compiler's own type table, and this is the same
 * strip asked of a `ts.Type`, for the censuses that answer a body read.
 *
 * `getNonNullableType` is the wrong instrument -- it strips `null` too, and
 * `p: T | null = null` is ordinary TypeScript whose body really does observe
 * the `null`.
 */
export const withoutUndefinedMember = (checker: ts.TypeChecker, type: ts.Type): ts.Type => {
  if (!type.isUnion()) return type
  const kept = type.types.filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0)
  if (kept.length === type.types.length || kept.length === 0) return type
  const sole = kept.length === 1 ? kept[0] : undefined
  if (sole) return sole
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(kept) : type
}

/** The class a constructor-object type (`typeof C`) belongs to, or `null` for any other type. */
const classOfConstructorType = (type: ts.Type): ts.Symbol | null =>
  type.symbol !== undefined && (type.symbol.flags & ts.SymbolFlags.Class) !== 0 && type.getConstructSignatures().length > 0
    ? type.symbol
    : null

/** Whether `a` and `b` are the constructor objects of two different classes -- nominally distinct, whatever their shapes. */
export const isDistinctClassConstructorPair = (a: ts.Type, b: ts.Type): boolean => {
  const first = classOfConstructorType(a)
  const second = classOfConstructorType(b)
  return first !== null && second !== null && first !== second
}

/** Shape subtyping cannot discard the identity of a class constructor selected at runtime. */
export const nominalConstructorChoiceTypeAt = (
  checker: ts.TypeChecker,
  node: ts.Node,
  read: (operand: ts.Expression) => ts.Type
): ts.Type | null => {
  if (ts.isParenthesizedExpression(node)) return nominalConstructorChoiceTypeAt(checker, node.expression, read)
  if (!ts.isConditionalExpression(node)) return null
  const arms = [read(node.whenTrue), read(node.whenFalse)].flatMap((type) => (type.isUnion() ? type.types : [type]))
  if (arms.some((arm) => classOfConstructorType(arm) === null)) return null
  return disjointUnionTypeOf(checker, arms)
}

export const widestOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): ts.Type | null => {
  const agree = (other: ts.Type, candidate: ts.Type): boolean => {
    const candidateArity = soleCallArity(candidate)
    const otherArity = soleCallArity(other)
    if (candidateArity !== null && otherArity !== null && candidateArity !== otherArity) return false
    // Two DIFFERENT classes' constructor objects never agree, however alike
    // their shapes: `class {}` beside `class X {}` is structurally assignable
    // both ways to the checker, but this compiler's `constructor-family`
    // carrier is nominal (one class per carrier), and a join that picked one
    // as "the" type made the other's default convert into it --
    // `[cls = class {}, xCls = class X {}]` read `xCls.name` as `"cls"`.
    if (isDistinctClassConstructorPair(other, candidate)) return false
    if (!checker.isTypeAssignableTo(other, candidate)) return false
    // Assignability is not carriage, the same reason the nominal veto above
    // exists. A union with a VACUOUS member alongside real ones -- hono's
    // `Env?: E['Bindings'] | {}` -- absorbs every object type there is, so a
    // candidate carrying one "covers" observations it says nothing about:
    // `widestOf([E['Bindings'] | {} | undefined, ExecutionContext |
    // undefined])` answered the first, and the array built from it
    // (`parameter-slot.ts`'s rest element, reached through `joinOfWrites`'s
    // call-site tail join) named no `ExecutionContext` at all -- so
    // `app.request(path, init, Env, executionCtx)` forwarding a real one had
    // no conversion into it.
    //
    // Re-asked with the candidate's vacuous members removed: coverage that
    // survives was real and stands, coverage that does not was `{}`'s alone
    // and this is a disagreement, which every caller already handles (a union
    // of the observations, or the checker's own answer left standing).
    //
    // Only for a candidate that is a UNION with BOTH vacuous and non-vacuous
    // members. A wholly vacuous candidate is deliberately left exactly as it
    // was: `{}` is also the type of an EMPTY OBJECT LITERAL the program
    // evaluated, where it is the most precise statement there is rather than
    // a non-statement (see `exactEmptyObjectLiteralType`), and the censuses
    // that must not admit a vacuous ANNOTATION already filter it before they
    // ever get here (`field-bindings.ts`'s `known`).
    if (!candidate.isUnion()) return true
    const stated = withoutVacuousMembers(checker, null, candidate)
    if (stated === null || stated === candidate) return true
    return checker.isTypeAssignableTo(other, stated)
  }
  for (const candidate of types) {
    if (types.every((other) => other === candidate || agree(other, candidate))) return candidate
  }
  return null
}

/**
 * Whether `type` states one value of a wider primitive. `isLiteral()` covers
 * string/number/bigint literals but, per the checker's own design, never a
 * boolean literal -- `true`/`false` are distinct intrinsic types, not
 * `LiteralType`s -- even though `getBaseTypeOfLiteralType` still widens them
 * to `boolean` correctly when asked. Shared so both call sites below agree.
 */
const hasLiteralForm = (type: ts.Type): boolean => type.isLiteral() || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0

/** `type`, widened off its literal form when it has one -- `"a" + "b"` is `string`, not the literal `"ab"` nobody wrote. */
const widenLiteral = (checker: ts.TypeChecker, type: ts.Type): ts.Type =>
  hasLiteralForm(type) ? checker.getBaseTypeOfLiteralType(type) : type

const ARITHMETIC_ONLY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
])

const LOGICAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken
])

const binaryExpressionType = (
  checker: ts.TypeChecker,
  node: ts.BinaryExpression,
  read: (operand: ts.Expression) => ts.Type | null
): ts.Type | null => {
  const op = node.operatorToken.kind
  if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) {
    const left = read(node.left)
    const right = read(node.right)
    if (!left || !right) return null
    // ECMA-262 12.15.5: EITHER operand being a string makes the whole
    // expression string concatenation.
    if (stringDomain(left)) return widenLiteral(checker, left)
    if (stringDomain(right)) return widenLiteral(checker, right)
    if (numberDomain(left) && numberDomain(right)) return widenLiteral(checker, left)
    return null
  }
  if (ARITHMETIC_ONLY_OPERATORS.has(op)) {
    const left = read(node.left)
    const right = read(node.right)
    if (!left || !right || !numberDomain(left) || !numberDomain(right)) return null
    return widenLiteral(checker, left)
  }
  if (LOGICAL_OPERATORS.has(op)) {
    const left = read(node.left)
    const right = read(node.right)
    if (!left || !right) return null
    const operator = op === ts.SyntaxKind.AmpersandAmpersandToken ? '&&' : op === ts.SyntaxKind.BarBarToken ? '||' : '??'
    return logicalResultTypeOf(checker, operator, left, right)
  }
  return null
}

/**
 * Whether two expressions are the SAME pure read of the same storage, with no
 * evaluation hidden in either of them.
 *
 * Two shapes qualify, and deliberately no others. Property reads can invoke
 * accessors and arbitrary computed keys can call user code, so this is much
 * smaller than syntactic equality:
 *
 *  - two IDENTIFIERS resolving to one symbol. A bare identifier read has no
 *    receiver, no key and no user code behind it at all -- it is strictly
 *    purer than the element access below, not a relaxation of it. Comparing
 *    SYMBOLS rather than source spelling keeps shadowed bindings distinct.
 *  - two element accesses reading one slot of one checker-proven Array
 *    through an identifier-bound receiver and an identifier/literal index --
 *    exactly the carrier this compiler lowers through
 *    `ArrayObject::elementAt`.
 *
 * Used only across the authenticated, pure `Array.isArray` call immediately
 * below. There is therefore no operation between the two reads that can
 * mutate the storage -- which is why a `let` binding is admitted alongside a
 * `const` one: nothing can run between a conditional's condition and the arm
 * it selects.
 */
const sameStablePureRead = (checker: ts.TypeChecker, left: ts.Expression, right: ts.Expression): boolean => {
  while (ts.isParenthesizedExpression(left) || ts.isNonNullExpression(left)) left = left.expression
  while (ts.isParenthesizedExpression(right) || ts.isNonNullExpression(right)) right = right.expression
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) {
    const symbol = checker.getSymbolAtLocation(left)
    return symbol !== undefined && symbol === checker.getSymbolAtLocation(right)
  }
  if (!ts.isElementAccessExpression(left) || !ts.isElementAccessExpression(right)) return false
  if (!ts.isIdentifier(left.expression) || !ts.isIdentifier(right.expression)) return false
  const leftReceiver = checker.getSymbolAtLocation(left.expression)
  const rightReceiver = checker.getSymbolAtLocation(right.expression)
  if (!leftReceiver || leftReceiver !== rightReceiver) return false
  const receiverType = checker.getNonNullableType(checker.getTypeAtLocation(left.expression))
  if (!checker.isArrayType(receiverType)) return false
  const leftKey = left.argumentExpression
  const rightKey = right.argumentExpression
  if (!leftKey || !rightKey) return false
  if (ts.isIdentifier(leftKey) && ts.isIdentifier(rightKey)) {
    const leftSymbol = checker.getSymbolAtLocation(leftKey)
    return leftSymbol !== undefined && leftSymbol === checker.getSymbolAtLocation(rightKey)
  }
  if (ts.isNumericLiteral(leftKey) && ts.isNumericLiteral(rightKey)) return leftKey.text === rightKey.text
  if (ts.isStringLiteralLike(leftKey) && ts.isStringLiteralLike(rightKey)) return leftKey.text === rightKey.text
  return false
}

/**
 * The array carrier selected by the normalizing idiom
 *
 *     Array.isArray(values[i]) ? values[i] : [values[i]]
 *     Array.isArray(data) ? data : [data]
 *
 * or `null` when the expression does not prove that one carrier.
 *
 * A binding census can know more about `values[i]` than TypeScript's checker
 * does. Three's `UniformsGroup.copy` is the measured case: the census has
 * `Uniform | Uniform[]`, while the JSDoc-backed array literal still has
 * `Uniform[]`. The generic conditional join sees `Uniform | Uniform[]` and
 * republishes that union, losing the fact the condition just established;
 * the subsequent numeric read then correctly refuses a union whose scalar arm
 * is not indexable.
 *
 * The rule is tied to the real global `Array.isArray`, to a repeated stable
 * PURE READ -- a bare identifier, or one slot of one proven native Array --
 * and to a one-element alternate containing that same read. The IDENTIFIER
 * form is what a one-or-many parameter is normally written over -- hono's
 * `node-server` websocket bridge is `const datas = Array.isArray(data) ?
 * data : [data]` over `data: WebSocketData` -- and without it the join
 * republished the whole union, so the `for (const data of datas)` that
 * follows read an element off a carrier whose scalar arms are not indexable
 * at all. Every array arm already discovered for the slot must fit the
 * alternate's array type. Thus the answer is the carrier both reachable arms
 * share; this does not turn a general predicate or a mutable/accessor read
 * into a narrowing.
 */
export const normalizedArrayConditionalType = (
  checker: ts.TypeChecker,
  node: ts.ConditionalExpression,
  read: (operand: ts.Expression) => ts.Type | null
): ts.Type | null => {
  const condition = node.condition
  if (!ts.isCallExpression(condition) || condition.arguments.length !== 1) return null
  const callee = condition.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'isArray') return null
  const receiverType = checker.getTypeAtLocation(callee.expression)
  if (!isStandardInterfaceType(checker, callee.expression, 'ArrayConstructor', receiverType)) return null
  const tested = condition.arguments[0]
  if (!tested || !sameStablePureRead(checker, tested, node.whenTrue)) return null
  if (!ts.isArrayLiteralExpression(node.whenFalse) || node.whenFalse.elements.length !== 1) return null
  const singleton = node.whenFalse.elements[0]
  if (!singleton || ts.isSpreadElement(singleton) || !sameStablePureRead(checker, tested, singleton)) return null
  const alternate = read(node.whenFalse)
  const source = read(tested)
  if (!alternate || !source || !checker.isArrayType(alternate)) return null
  const sourceMembers = source.isUnion() ? source.types : [source]
  // A `readonly T[]` member is NOT admitted here, although `readonly` has no
  // physical reading in this compiler (`structural.ts` publishes every array
  // as `readonly: false`) and node-server's
  // `WebSocketData = string | ArrayBuffer | Uint8Array | readonly Uint8Array[]`
  // is refused for exactly that spelling. Admitting it was measured: the
  // arm's element is NARROWER than the alternate's (`Uint8Array` against the
  // whole union), so the answer widens an array's element -- and the binding
  // conversion this function feeds then selected an arm that produced an
  // EMPTY array at runtime instead of refusing. A plain
  // `array-object(record) -> array-object(tagged-union)` is refused outright
  // (`conversion:array-object(...)->array-object(...)`: no runtime conversion
  // installed), which is the correct fail-closed answer; reaching the same
  // widening through this idiom's arm selection turned that refusal into a
  // wrong answer, so the arm selection is what has to be fixed before the
  // spelling can be admitted.
  const arrayMembers = sourceMembers.filter((member) => checker.isArrayType(checker.getNonNullableType(member)))
  if (!arrayMembers.every((member) => checker.isTypeAssignableTo(member, alternate))) return null
  // With no array arm the authenticated predicate is statically false only
  // for a concrete class instance. An interface/object/type parameter can
  // still describe an Array value structurally, and `any`/`unknown` state no
  // carrier at all, so none of those license the same conclusion.
  if (arrayMembers.length === 0) {
    const symbol = checker.getNonNullableType(source).getSymbol()
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return null
  }
  return alternate
}

/**
 * The type an `arg is any[]` predicate REALLY establishes, when the checker
 * answered with the intersection it falls back to.
 *
 * `Array.isArray`'s `lib.es5.d.ts` signature is `isArray(arg: any): arg is
 * any[]`, and TypeScript narrows a union by a predicate by KEEPING the
 * constituents assignable to the predicate's type. Where none is, it does not
 * answer `never` -- it answers the INTERSECTION `T & any[]`, distributed over
 * `T`'s arms, and every read through it is typed `any`:
 *
 *     Array.isArray(value) ? value[0] : value          // value: string
 *     Array.isArray(pattern) ? pattern[0] : p          // readonly [...] | '*'
 *
 * (`@hono/node-server`'s `createUpgradeRequest` and hono's trie router; a
 * `readonly` tuple is not assignable to the mutable `any[]` either, so the
 * fallback fires for a type that IS an array.) That `any` is an artifact of a
 * failed narrowing, not a boundary the program declared: the value is a
 * `std::string` or a fixed tuple and the read has a stated answer either way.
 * Carried as `dynamic` it reached the backend as a result with no absence
 * materialization, and boxing the read to make it compile is the shortcut this
 * compiler does not take.
 *
 * `any[]` states no carrier at all (`isUnusableEvidence`), so intersecting
 * with it adds nothing physical; what it adds is the assertion that the value
 * is an array HERE. So the answer is the array/tuple constituents of the rest
 * -- and with none of those the predicate is statically false for a value that
 * has a carrier, the arm is dead, and the honest type is the one the value
 * already had. Only a SINGLE surviving subject is answered: two array arms
 * would need a join this is not the place to take.
 */
export const arrayPredicateNarrowedTypeOf = (checker: ts.TypeChecker, type: ts.Type): ts.Type | null => {
  const isPredicateArray = (part: ts.Type): boolean =>
    checker.isArrayType(part) && isUnusableEvidence(checker.getTypeArguments(part as ts.TypeReference)[0] ?? part)
  const subjects: ts.Type[] = []
  for (const member of type.isUnion() ? type.types : [type]) {
    if (!member.isIntersection()) return null
    const rest = member.types.filter((part) => !isPredicateArray(part))
    const subject = rest.length === 1 ? rest[0] : undefined
    if (subject === undefined || rest.length === member.types.length) return null
    subjects.push(subject)
  }
  const arrays = subjects.filter((subject) => checker.isArrayType(subject) || checker.isTupleType(subject))
  if (arrays.length === 1) return arrays[0] ?? null
  return arrays.length === 0 && subjects.length === 1 ? (subjects[0] ?? null) : null
}

/**
 * The element an `x[k]` read produces when the checker typed it `any` only
 * because `x` is standing in an `arg is any[]` narrowing's intersection.
 *
 * The key is answered off the narrowed subject exactly as any other read is:
 * a literal key names a member (a tuple's `[0]` is its first element type,
 * not the join of all of them), and anything else takes the receiver's own
 * index signature -- `String`'s is `readonly [index: number]: string`, which
 * is the carrier `stringIndexText`'s `charAt` already renders.
 */
export const arrayPredicateNarrowedElementTypeOf = (checker: ts.TypeChecker, node: ts.ElementAccessExpression): ts.Type | null => {
  if (!isUnusableEvidence(checker.getTypeAtLocation(node))) return null
  const narrowed = arrayPredicateNarrowedTypeOf(checker, checker.getTypeAtLocation(node.expression))
  if (narrowed === null) return null
  const name = literalMemberNameOf(node)
  const property = name === null ? undefined : checker.getPropertyOfType(narrowed, name)
  if (property) {
    const member = checker.getTypeOfSymbolAtLocation(property, node)
    return isUnusableEvidence(member) ? null : member
  }
  const key = node.argumentExpression
  return key ? indexedTypeOf(checker, narrowed, checker.getTypeAtLocation(key), node) : null
}

/**
 * The outcome of `x === undefined`, `x !== null`, `x == null` (either side
 * literal) when `read` types `x` as nothing but the nullish value(s) it is
 * compared with or against -- `null` when the operands do not decide it.
 *
 * `( gl[ p ] !== undefined ) ? gl[ p ] : null` (three's `WebGLUtils.convert`)
 * is the shape: once the element read is proved `undefined`, the arms are
 * `undefined` and `null`, which `joinOfWrites` rightly refuses to join -- but
 * the untaken arm contributes no value, so the conditional is its other arm.
 * The literal side is recognised by syntax and the standard `undefined`
 * binding's identity, never read, so a census's read of it cannot attribute a
 * refusal of its own.
 */
const decidedNullishEqualityOf = (
  checker: ts.TypeChecker,
  condition: ts.Expression,
  read: (operand: ts.Expression) => ts.Type | null
): boolean | null => {
  let test = condition
  while (ts.isParenthesizedExpression(test)) test = test.expression
  if (!ts.isBinaryExpression(test)) return null
  const operator = test.operatorToken.kind
  const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
  const loose = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  if (!strict && !loose) return null
  const literalNullish = (side: ts.Expression): ts.TypeFlags.Undefined | ts.TypeFlags.Null | null => {
    let value = side
    while (ts.isParenthesizedExpression(value)) value = value.expression
    if (value.kind === ts.SyntaxKind.NullKeyword) return ts.TypeFlags.Null
    if (ts.isVoidExpression(value)) return ts.TypeFlags.Undefined
    return ts.isIdentifier(value) && value.text === 'undefined' && isStandardGlobalValue(checker, value, 'undefined')
      ? ts.TypeFlags.Undefined
      : null
  }
  const left = literalNullish(test.left)
  const right = literalNullish(test.right)
  const literal = left ?? right
  if (literal === null || (left !== null && right !== null)) return null
  const operand = read(left === null ? test.left : test.right)
  if (!operand) return null
  const flags = operand.flags & NULLISH_FLAGS
  if (flags === 0 || (operand.flags & ~NULLISH_FLAGS) !== 0) return null
  // `==` treats `null` and `undefined` as equal; `===` only a match of each.
  const equal = loose ? true : flags === literal ? true : (flags & literal) === 0 ? false : null
  if (equal === null) return null
  const negated = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  return negated ? !equal : equal
}

/**
 * `node`'s own type, derived from its immediate operands via `read`.
 *
 * Handles exactly the composite shapes described in this file's header
 * comment, and nothing else: this is a LEAF function, not a walker -- it
 * asks `read` for each operand's type and combines the answers by the
 * operator's own fixed rule, doing no traversal of its own beyond that one
 * level. Every caller supplies its own `read` (its `known ?? resolve`), so
 * this function's own recursion depth is always exactly one.
 */
export const derivedExpressionType = (
  checker: ts.TypeChecker,
  node: ts.Expression,
  read: (operand: ts.Expression) => ts.Type | null
): ts.Type | null => {
  if (ts.isConditionalExpression(node)) {
    const whenTrue = read(node.whenTrue)
    const whenFalse = read(node.whenFalse)
    // A ternary's two arms are a two-element WRITE SET to one storage
    // location -- the value the expression evaluates to. `cond ? x : null`
    // is exactly the "sometimes empty, otherwise T" shape `joinOfWrites`
    // exists for (see its own header comment), and `cond ? 5126 : 5131`
    // is exactly the same literal-form-agreement shape. `widestOf` alone
    // answers FIRST and unchanged; only a pair it already refused reaches
    // `joinOfWrites`'s nullish-partition and literal-widening retries. Kept
    // to the ONE join this compiler owns rather than a second copy of its
    // reasoning.
    const joined = whenTrue && whenFalse ? joinOfWrites(checker, [whenTrue, whenFalse]) : null
    if (joined) return joined
    // Only a pair the join refused asks the condition: a census that attributes
    // a refusal to every unresolved operand must not see one more read here
    // than it did before on any conditional it already answered.
    const decided = decidedNullishEqualityOf(checker, node.condition, read)
    return decided === null ? null : decided ? whenTrue : whenFalse
  }
  if (ts.isBinaryExpression(node)) return binaryExpressionType(checker, node, read)
  if (ts.isTemplateExpression(node)) {
    // Defensive only -- see header comment. `ToString` is total, so the
    // checker already reports `string` here without this module's help in
    // every case observed; this exists so a genuine surprise refuses
    // instead of throwing.
    const own = checker.getTypeAtLocation(node)
    return isUnusableEvidence(own) ? null : own
  }
  return null
}

/** `null`/`undefined` and nothing else: a write stating the storage is EMPTY rather than naming a type for it. */
const NULLISH_FLAGS = ts.TypeFlags.Null | ts.TypeFlags.Undefined
export const isNullishType = (type: ts.Type): boolean => (type.flags & NULLISH_FLAGS) !== 0 && (type.flags & ~NULLISH_FLAGS) === 0

/** `type` off its literal form, the same rule `widenLiteral` above states. */
const widenLiteralForm = (checker: ts.TypeChecker, type: ts.Type): ts.Type =>
  hasLiteralForm(type) ? checker.getBaseTypeOfLiteralType(type) : type

/**
 * The join of a WRITE SET -- every value the program stores into one storage
 * location -- once the two things `widestOf` reads as a disagreement but
 * which are not one have been accounted for; or `null` when the writes
 * genuinely do not agree.
 *
 * `widestOf` answers FIRST and unchanged, so every location bound today binds
 * to exactly the same type; only a set it has already refused reaches the
 * rest of this.
 *
 * ## A nullish write states ABSENCE, not a rival type
 *
 * `widestOf` asks whether one OBSERVED type covers every other, and under
 * `strictNullChecks` no object type covers `null`. So the single commonest
 * shape a write-set census exists for -- `let currentProgram = null;` filled
 * in later with a real value and set back to `null` on teardown, or
 * `this.view = null` in a constructor and a real object in a setter --
 * refuses, attributed `writes-disagree`: the join read the location's own
 * emptiness as a type competing for the slot. It is not one. Storage that is
 * sometimes empty and otherwise holds `T` is exactly `T | null` -- the
 * `optional(T, null)` carrier this compiler already has, not a union of its
 * own making. Every constituent is still a type the program itself wrote.
 *
 * `getNullableType` is the checker's own constructor for that union, the
 * same one `return-bindings.ts` uses for a `Map.get` result and
 * `parameter-slot.ts` for a defaulted parameter, and it flattens -- so a
 * write already typed `T | null` re-joins to `T | null` rather than nesting.
 *
 * The observed nullish FLAGS are carried through rather than fixed: writes
 * holding `null` yield `T | null`, `undefined` yields `T | undefined`, both
 * yield both. Answering `null` where the program only ever wrote `undefined`
 * (or the reverse) would be inventing an inhabitant no census here may
 * invent. And a set that is ENTIRELY nullish is left to `widestOf`, which
 * already answers it on its own.
 *
 * ## A literal FORM is not a disagreement either
 *
 * The other shape is storage whose every write is a different LITERAL of one
 * primitive: `let type;` in three's `WebGLAttributes.js` is written `5126`,
 * `5131`, `5123`, `5122`, `5125`, `5124`, `5120`, `5121` -- eight writes,
 * eight literal types, none covering another, refused. The storage question
 * has an answer nobody has to invent: `number`. It is TypeScript's own
 * answer too -- a `let` initialized with `5126` is widened to `number` by
 * the language's mutable-binding rule, and the literal type survives here
 * only because these censuses read the RIGHT-HAND SIDE expression rather
 * than the declaration. `widenLiteral` above states the same rule for the
 * same reason (`"a" + "b"` is `string`, not the literal `"ab"` nobody
 * wrote). Tried only after the unwidened join has refused, so storage whose
 * writes DO agree on a literal keeps it.
 *
 * ## Why this is shared rather than copied
 *
 * `local-bindings.ts` (a `let`/`var` cell) and `field-bindings.ts` (a class
 * field) ask the identical question of two different declaration kinds, and
 * a field written `null` in the constructor and filled in later is the same
 * shape as the cell this landed for. Two copies of a join rule is the
 * "two authorities" defect this compiler keeps paying for -- the same
 * reasoning that made `annotationStatesNothing` shared. One rule, one file,
 * asked by both.
 */
export const joinOfWrites = (checker: ts.TypeChecker, types: readonly ts.Type[]): ts.Type | null => {
  const direct = widestOf(checker, types)
  if (direct) return direct
  let observed = 0
  const present: ts.Type[] = []
  for (const type of types) {
    if (isNullishType(type)) observed |= type.flags & NULLISH_FLAGS
    else present.push(type)
  }
  if (present.length === 0) return null
  const joined =
    (observed === 0 ? null : widestOf(checker, present)) ??
    widestOf(
      checker,
      present.map((part) => widenLiteralForm(checker, part))
    )
  if (!joined) return null
  return observed === 0 ? joined : checker.getNullableType(joined, observed)
}

/**
 * A member with no evidence at all -- vetoes the whole set (see
 * `disjointArmsOf`). Deliberately wider than `isUnusableEvidence` above:
 * `unknown` is a genuine dynamic boundary here too, not merely a case that
 * other join rules leave alone.
 *
 * Exported for `parameter-bindings.ts`'s `restElementTypeAt`: a rest
 * parameter's own binding can be REASSIGNED in the body (`params =
 * enhanceLogMessage(params)`), and that write is evidence about the SAME
 * cell the call-site tail is joined into -- an `Array<any>`-returning
 * reassignment is exactly the "genuine dynamic boundary" this test already
 * names, not a second question needing its own copy of the flag set.
 */
export const carriesNoEvidence = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/**
 * The DISTINCT, pairwise-disjoint members of `types` -- every one a real
 * type, none of them subsuming another -- or `null` when the set cannot
 * safely become one union.
 *
 * `joinOfWrites` above answers "is there ONE type every write agrees on".
 * This is the question that only gets asked once that has already failed:
 * is the DISAGREEMENT ITSELF the answer? `A | B | C`, where `A`, `B`, `C` are
 * exactly the types the program's own write sites used, is not a guess when
 * every one of them is real and none of them overlaps another -- it is
 * precisely what the program does. This compiler's `tagged-union`
 * representation (`representation/model.ts`) exists for it.
 *
 * Two members overlap when either is assignable to the other -- the SAME
 * `checker.isTypeAssignableTo` `widestOf`'s own `agree` reads a single
 * covering candidate from above, applied PAIRWISE instead of one-to-all.
 * Assignable in one direction only is a subsumption (a literal `5` inside
 * `number`, or one record type's fields a strict subset of another's) --
 * accepting it would let a value that is honestly a `B` also match arm `A`,
 * which is a mis-selection, not a conservative one, so the WHOLE set
 * refuses rather than dropping the overlapping member. Assignable both ways
 * is the same member spelled twice (two structurally-identical types, or
 * two references to one declaration) and collapses to one arm silently,
 * the same reduction `representation/union.ts`'s own `canonicalMembersOf`
 * performs one layer down. Neither direction is exactly ECMAScript's own
 * "no runtime value can satisfy both", which is the fact a tagged union's
 * arms need to be told apart at all -- see that file's own module comment.
 *
 * A member that states no evidence at all (`any`/`unknown`/`void`/`never`)
 * vetoes the whole set outright: unioning a real type with "nothing was
 * declared" would launder the missing statement as if it were one more arm,
 * and `void`/`never` are refusals about the STORAGE, not values competing
 * for the slot.
 *
 * Cardinality is not missing evidence. Preserve every admitted member of a
 * finite write set; representation planning owns its storage and dispatch
 * costs. An earlier four-arm cutoff erased complete five-way inputs and
 * made downstream forwarding indistinguishable from an unknown caller.
 */
export const disjointArmsOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): readonly ts.Type[] | null => {
  const arms: ts.Type[] = []
  for (const type of types) {
    if (carriesNoEvidence(type)) return null
    let duplicate = false
    for (const existing of arms) {
      // Two different classes' constructor objects are disjoint by identity,
      // whatever the checker says of their shapes -- `widestOf`'s rule.
      if (isDistinctClassConstructorPair(type, existing)) continue
      const forward = checker.isTypeAssignableTo(type, existing)
      const backward = checker.isTypeAssignableTo(existing, type)
      if (forward && backward) {
        duplicate = true
        break
      }
      if (forward || backward) return null // one member subsumes the other: not disjoint
    }
    if (!duplicate) arms.push(type)
  }
  return arms.length >= 2 ? arms : null
}

/**
 * The full member list for a SYNTHESIZED union carrier, once `joinOfWrites`
 * has already refused -- every present (non-nullish) write partitioned the
 * identical way `joinOfWrites` partitions them, checked for disjointness via
 * `disjointArmsOf`, with the observed absence values (`null`/`undefined`)
 * carried through UNCHANGED as members rather than folded into a flag here.
 *
 * That last point is deliberate, not an oversight: this function answers a
 * STRUCTURAL question ("what are this union's members"), not a `ts.Type`
 * one -- `ts.TypeChecker.getUnionType` is not on the public surface (see
 * `absent-globals.ts` and `producers/bindings.ts`'s own comments on the same
 * wall), so unlike `joinOfWrites` this cannot hand back one `ts.Type` a
 * caller re-derives structurally. It hands back the member LIST instead, for
 * a caller that is about to `table.intern({ kind: 'union', members:
 * list.map(typeOf) })` directly -- and `representation/union.ts`'s own
 * `deriveUnion` already partitions absent members from present ones and
 * wraps the result in `optional` exactly as `joinOfWrites` would have, so
 * passing the nullish members through as ordinary list entries here, rather
 * than pre-collapsing them, is asking that ONE authority to do it once
 * instead of a second copy of the same partition living here too.
 */
export const disjointUnionMembersOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): readonly ts.Type[] | null => {
  const present: ts.Type[] = []
  const nullish: ts.Type[] = []
  const atomsOf = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types.flatMap(atomsOf) : [type])
  for (const type of types)
    for (const atom of atomsOf(type)) {
      const widened = widenLiteralForm(checker, atom)
      if (isNullishType(widened)) {
        if (!nullish.some((seen) => seen.flags === widened.flags)) nullish.push(widened)
      } else present.push(widened)
    }
  const arms = disjointArmsOf(checker, present)
  return arms ? [...arms, ...nullish] : null
}

/**
 * `disjointUnionMembersOf`, answered as ONE `ts.Type` -- for a census whose
 * contract is a `ts.Type` and whose every consumer reads one.
 *
 * `collection-bindings.ts`'s array-element census is that census: every
 * sibling write-set census (a `let` cell, a class field, a parameter, a
 * return) already answers a disagreeing write set as a disjoint tagged union
 * through its own `unionArmsAt` channel, while the array census asked
 * `joinOfWrites` alone and REFUSED the same disagreement
 * (`array:elements-disagree`). `var xs = []; xs.push(1); xs.push('a')` is the
 * shape: the array's storage fell to the box, and every `push` boxed its
 * argument on the way in, for a program that declared nothing dynamic.
 *
 * Two things make the `ts.Type` form the right one here rather than a fourth
 * arms channel. The census's array answers travel through `arrayElementAt`/
 * `arrayElementForRead`/`arrayElementForOwner` into three other censuses that
 * read a `ts.Type` (`local-bindings.ts`, `return-bindings.ts`,
 * `field-bindings.ts`), so a list would leave every one of them answering the
 * checker's `any` for a union the storage already carries. And the checker's
 * OWN evolving-array machinery settles the SAME array to the SAME union at
 * every reference it can finalize (`xs.join(...)` after the pushes is `(string
 * | number)[]` there): TypeScript widens each pushed value off its literal form
 * (`addEvolvingArrayElementType`, `getBaseTypeOfLiteralType`) and unions the
 * results. Building the union through the checker from the identically
 * widened members yields the IDENTICAL `ts.Type` object (verified: `built ===
 * settled` for `[number, string, boolean]`), so the storage the census types,
 * the reads the checker settled, and the `push` slots
 * (`structural.ts`'s `evolvingArrayMemberTypeAt`) intern to one structural
 * type with no conversion between them. An arms list interned separately
 * could not promise that.
 *
 * Widening is therefore part of the rule, not a convenience: unwidened, `1`
 * and `"a"` are two disjoint LITERAL arms, and a storage of `1 | "a"` would be
 * a second authority beside the checker's `string | number` at every settled
 * read. `disjointUnionMembersOf`'s own soundness test (no member subsumes
 * another) is applied unchanged to the
 * widened members, so a set the cell census would refuse is refused here too.
 *
 * Built through the checker's internal `getUnionType`, the same guarded reach
 * `withoutUndefinedMember` above and `field-bindings.ts`'s `withNullish` make;
 * a checker without it answers `null`, which is the refusal the caller already
 * handles.
 */
export const disjointUnionTypeOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): ts.Type | null => {
  const members = disjointUnionMembersOf(
    checker,
    types.map((type) => widenLiteralForm(checker, type))
  )
  if (!members) return null
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(members) : null
}

// -----------------------------------------------------------------------
// CALLABLE VALUE FLOW -- moved here from a would-be sibling module because
// `normalize/` sits at the architecture gate's directory-file cap. This
// section answers `parameter-bindings.ts`'s one question about a reference
// to a named function -- "what value does it stand for" -- plus the two
// symbol-anchored ALIAS evidence indexes (`indexNamedCallables`,
// `indexAliasEvidence`) that let a call through a resolved member or a
// selector's result count as a real call site of the function it names.
// -----------------------------------------------------------------------

/**
 * The parts of `parameter-bindings.ts` that answer one question --
 * "what value does this reference of a named function's identifier stand
 * for" -- without touching that module's own fixpoint state. Moved here so
 * `parameter-bindings.ts` has room, under the architecture gate, for the
 * value-flow evidence this module also builds: `indexNamedCallables` and
 * `indexAliasEvidence`, below.
 */

/** Whether this declaration is one of the five function-like shapes the parameter-binding census tracks. */
export const isTrackedCallable = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isConstructorDeclaration(node)

/**
 * The real callee and the arguments that actually reach it, once an explicit-
 * `this` wrapper -- `.call( thisArg, ...args )` or `.apply( thisArg, [ ...
 * args ] )` -- is unwrapped, or `null` when this call is neither.
 *
 * `EventDispatcher.dispatchEvent` calls every registered listener as
 * `array[ i ].call( this, event )`: a call to `array[ i ]`, with ONE argument,
 * not a call to `Function.prototype.call` with two. Left wrapped, `checker.
 * getResolvedSignature` resolves `.call`'s own (unrelated) ambient signature
 * successfully -- it is not `any`, so it never fell through to the fallback
 * that would have resolved the real callee -- and the call vanished from
 * every candidate's evidence without a trace: not refused, simply never
 * counted. `collect` skips recording checker attribution for these and
 * `attributeCalls`/`agreedArgumentType` read this map instead of the raw
 * node, so the SAME machinery that already resolves an ordinary call site's
 * callee and arguments does the resolving here too, just against `callee`
 * and `args` rather than `call.expression` and `call.arguments`.
 *
 * `.apply` is unwrapped only when its argument list is a literal array with
 * no spread (`.apply( this, [ a, b ] )`) -- anything else (a spread, a
 * variable holding the array) stays wrapped rather than guessed at, exactly
 * the same "refuse rather than invent" rule this module uses everywhere
 * else.
 *
 * The RECEIVER -- `call.expression.expression`, `array[ i ]` above -- must
 * itself be a FUNCTION VALUE before any of this fires. `.call`/`.apply` are
 * ordinary member names, and a program is free to declare its own object with
 * a `.call( ... )` or `.apply( ... )` method (a Command/Strategy pattern, a
 * Callable-shaped API): unwrapping THAT receiver would silently replace its
 * real callee and arguments with wrong ones, from a name match with no
 * relationship to `Function.prototype.call`/`.apply` at all. The receiver's
 * own static type having at least one CALL SIGNATURE is what makes it
 * actually a function value -- the same fact `parameter-bindings.ts`'s
 * `isUnannotated` reads off a `Function`-typed parameter, asked here of the
 * `.call`/`.apply` receiver instead.
 */
export const unwrapExplicitThisCall = (checker: ts.TypeChecker, call: ts.CallExpression): ExplicitThisCallFrame | null => {
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  const name = call.expression.name.text
  if (name !== 'call' && name !== 'apply') return null
  const member = checker.getSymbolAtLocation(call.expression.name)
  if (!member?.declarations?.length || !member.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  const receiver = call.expression.expression
  if (checker.getSignaturesOfType(checker.getTypeAtLocation(receiver), ts.SignatureKind.Call).length === 0) return null
  if (name === 'call') return { callee: receiver, receiver: call.arguments[0] ?? null, args: call.arguments.slice(1) }
  if (call.arguments.length === 2) {
    const argumentsArray = call.arguments[1]
    if (
      argumentsArray &&
      ts.isArrayLiteralExpression(argumentsArray) &&
      argumentsArray.elements.every((element) => !ts.isSpreadElement(element))
    ) {
      return { callee: receiver, receiver: call.arguments[0] ?? null, args: argumentsArray.elements }
    }
  }
  return null
}

const staticInvocationKeyOf = (expression: ts.Expression): string | null => {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return null
  const argument = unwrapErasedExpression(expression.argumentExpression)
  if (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text
  if (ts.isNumericLiteral(argument)) {
    const key = String(Number(argument.text))
    return key === argument.text ? key : null
  }
  return null
}

const isWithin = (node: ts.Node, root: ts.Node | undefined): boolean => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === root) return true
  return false
}

const staticHomeObjectOf = (member: ts.ClassElement): boolean => (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0

const isInsideCallableExecution = (expression: ts.Expression, callable: ts.FunctionLikeDeclaration): boolean =>
  isWithin(expression, callable.body) || callable.parameters.some((parameter) => isWithin(expression, parameter))

const lexicalSuperHomeOf = (
  expression: ts.Expression
): { readonly home: ts.ClassDeclaration | ts.ClassExpression | ts.ObjectLiteralExpression | null; readonly static: boolean } => {
  for (let current: ts.Node | undefined = expression.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      const owner = current.parent
      if ((ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && isInsideCallableExecution(expression, current))
        return { home: owner, static: staticHomeObjectOf(current) }
      if (ts.isObjectLiteralExpression(owner) && isInsideCallableExecution(expression, current)) return { home: owner, static: false }
      // Computed names are evaluated in the enclosing context, not with this
      // member's home object. Keep walking so an enclosing method can own it.
      continue
    }
    if (ts.isConstructorDeclaration(current)) {
      const owner = current.parent
      return ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? { home: owner, static: false } : { home: null, static: false }
    }
    if (ts.isPropertyDeclaration(current)) {
      const owner = current.parent
      if ((ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && isWithin(expression, current.initializer))
        return { home: owner, static: staticHomeObjectOf(current) }
      continue
    }
    if (ts.isClassStaticBlockDeclaration(current)) {
      const owner = current.parent
      return ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? { home: owner, static: true } : { home: null, static: false }
    }
    if (ts.isFunctionLike(current)) return { home: null, static: false }
  }
  return { home: null, static: false }
}

const superConstructorHomeOf = (call: ts.CallExpression): ts.ClassDeclaration | ts.ClassExpression | null => {
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isConstructorDeclaration(current)) {
      const home = current.parent
      return isWithin(call, current.body) && (ts.isClassDeclaration(home) || ts.isClassExpression(home)) ? home : null
    }
    if (ts.isFunctionLike(current)) return null
  }
  return null
}

/** The actual operand frame of a source call, with authenticated `.call`/`.apply` wrappers erased.
 *
 * `pendingExplicitThisAt` is the round-over-round counterpart of
 * `unwrapExplicitThisCall`'s own static gate: that gate needs the receiver's
 * CHECKER type to already carry a call signature, which an untyped JS array
 * element never does -- `EventDispatcher.dispatchEvent`'s `array[ i ].call(
 * this, event )` types `array[ i ]` as `any` even with a `@param {Function}`
 * JSDoc tag on the pushing `addEventListener`, because the field the array
 * lives on (`this._listeners`) itself carries no type. Unwrapping THAT
 * receiver unconditionally would be unsound (a program's own `.call`-shaped
 * Command/Strategy object would be silently misread as `Function.prototype.
 * call`), so the census this resolver comes from proves the array's whole
 * write history is CLOSED to real function values first (`callableArrayTargetsOf`
 * in `parameter-bindings.ts`, the identical flow proof `callable-reach.ts`'s
 * own target resolution trusts) and supplies a reading only once that holds --
 * never guessed, and absent (round one, and every caller with no census yet)
 * this stays byte-identical to the always-unresolved answer it replaced. */
export const invocationOperandsOf = (
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
  pendingExplicitThisAt?: (call: ts.CallExpression) => ExplicitThisCallFrame | null
): FlowInvocationOperands => {
  const explicitThis = ts.isCallExpression(call) ? (unwrapExplicitThisCall(checker, call) ?? pendingExplicitThisAt?.(call) ?? null) : null
  const callee = unwrapErasedExpression(explicitThis?.callee ?? call.expression)
  const kind: FlowInvocationOperands['kind'] = ts.isNewExpression(call)
    ? 'construct'
    : callee.kind === ts.SyntaxKind.SuperKeyword
      ? 'super'
      : 'call'
  const receiver = explicitThis
    ? explicitThis.receiver
    : kind === 'call' && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      ? callee.expression
      : null
  let dispatch: FlowInvocationDispatch = { kind: 'direct' }
  if (kind === 'super') {
    dispatch = { kind: 'super-constructor', home: superConstructorHomeOf(call as ts.CallExpression) }
  } else if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    callee.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    dispatch = { kind: 'lexical-super', ...lexicalSuperHomeOf(callee), key: staticInvocationKeyOf(callee) }
  } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    dispatch = { kind: 'member', lookup: callee.expression, key: staticInvocationKeyOf(callee) }
  }
  return {
    kind,
    dispatch,
    explicitThis: explicitThis !== null,
    callee,
    receiver,
    args: explicitThis?.args ?? call.arguments ?? []
  }
}

/** Whether an identifier stands in the callee position of this call. */
export const isCalleeOf = (node: ts.Node, call: ts.CallExpression | ts.NewExpression): boolean =>
  (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === node

/**
 * The symbol that names this function's value, or `null` when nothing does.
 *
 * A function is enumerable exactly when the program refers to it by a name,
 * because a name is what a reference can be counted against. Three forms of
 * name exist and all three are ordinary: a declaration's own (`function f(){}`),
 * the variable a function expression initializes (`const f = function(){}`),
 * and the member a method declares (`{ f() {} }`, `class { f() {} }`). A
 * function expression written directly as an argument has no name at all, and
 * refusing it is right: its only caller is the function it was passed to, which
 * is precisely the caller this census cannot enumerate.
 */
export const nameOfCallable = (declaration: ts.SignatureDeclaration): ts.MemberName | null => {
  if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) {
    if (declaration.name) return declaration.name
  }
  // A private name is a name: `static #m(x) {}` is reached through `this.#m`
  // and nothing else, and the checker resolves that reference to the same
  // symbol an identifier's would. Left out, every private method was
  // `unnamed`, and every one of its parameters dynamic.
  if (ts.isMethodDeclaration(declaration) && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))) {
    return declaration.name
  }
  // A constructor is named by its class: `new WebGLRenderer( ... )` reaches it
  // through that name and no other.
  if (ts.isConstructorDeclaration(declaration)) {
    const owner = declaration.parent
    if (ts.isClassDeclaration(owner) && owner.name) return owner.name
  }
  const parent = declaration.parent
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === declaration && ts.isIdentifier(parent.name)) {
    return parent.name
  }
  if (parent && ts.isPropertyAssignment(parent) && parent.initializer === declaration && ts.isIdentifier(parent.name)) {
    return parent.name
  }
  // `this.render = function ( scene, camera ) { ... }` and `_this.shadowMap =
  // shadowMap` are how `WebGLRenderer` declares half its surface. TypeScript's
  // JavaScript inference does not read that idiom as a declaration, but the
  // member being assigned is still a NAME -- the same kind of name a method
  // declaration is -- and a name is all this needs to count references against.
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === declaration) {
    if (ts.isPropertyAccessExpression(parent.left) && ts.isIdentifier(parent.left.name)) return parent.left.name
    if (ts.isIdentifier(parent.left)) return parent.left
  }
  return null
}

/**
 * Whether a reference to a function's name is one that keeps it enumerable.
 *
 * An import or export specifier re-binds the name in another module's scope
 * without letting anything hold the function as a value, and a declaration's
 * own name is not a reference to it. A shorthand property in a returned object
 * (`return { has, init, get }`) is the idiom three's factories are built on:
 * the function is reachable only as a member of that record, so every call to
 * it is a member call this census resolves once the record has a type -- which
 * is what the fixpoint is for.
 *
 * Two more shapes are binding-only for the identical reason, one level of
 * indirection removed -- see `indexAliasEvidence` for the evidence that makes
 * each of them SOUND rather than merely silent:
 *
 * - a bare `return f;`: the SELECTOR-RETURN idiom (`getSingularSetter(type)`
 *   returning one of several named setters from a switch). The function is
 *   reachable only by calling whatever the selector returns, and
 *   `indexAliasEvidence.returnedFrom` records exactly which functions a given
 *   selector declaration can return, so a call through its result becomes
 *   real evidence for every one of them.
 * - `<propertyAccess> = f`: the MEMBER-PUBLICATION idiom (`this.setValue =
 *   setValueV3f`), the same idea `nameOfCallable` already handles for a
 *   function declared directly in that position, extended to a function
 *   merely REFERENCED there. `indexAliasEvidence.publishedUnderMember` keys
 *   on the checker's own symbol for the member, never its spelling, so a
 *   later call through an unrelated member that happens to share a name
 *   never matches.
 *
 * A fourth shape needs no alias evidence at all, because it carries no value
 * flow to begin with: a class named in a HERITAGE CLAUSE (`class Sub extends
 * Base`, `class Sub implements Base`). `ExpressionWithTypeArguments` is the
 * node TypeScript uses for exactly these two positions and nowhere else, so
 * a reference whose direct parent is one names the class being extended or
 * implemented -- it does not hand the class's constructor to anything. The
 * two ways a heritage mention could matter for a constructor's own
 * enumerability are both already real `NewExpression`/`CallExpression` nodes
 * this census's own `attributeCalls` visits and attributes through
 * `checker.getResolvedSignature`, independent of the heritage reference
 * itself: a `super(...)` call in a declared derived constructor resolves
 * straight to the base constructor's declaration, and `new Derived(...)`
 * where `Derived` declares no constructor of its own resolves to that same
 * base declaration too (TypeScript gives the derived class the base's own
 * construct signature when it has none -- measured directly against this
 * compiler's own checker: `new Derived(...)`'s resolved signature IS the
 * base constructor node, and a declared `super(...)` resolves to it too).
 * Counting the heritage mention as a further escape does not add evidence
 * the walk lacks -- it double-refuses a constructor whose real callers are
 * already enumerated elsewhere.
 *
 * Everything else -- an argument, a bare variable initializer, a return of
 * the bare name wrapped in a way that isn't a plain `ReturnStatement` -- hands
 * the function to a caller this census cannot see, and stays an escape.
 */
export const isBindingOnlyReference = (node: ts.MemberName): boolean => {
  const parent = node.parent
  if (!parent) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return true
  if (ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent)) return true
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isReturnStatement(parent) && parent.expression === node) return true
  if (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) return true
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isPropertyAccessExpression(parent.left)
  ) {
    return true
  }
  return ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) ? parent.name === node : false
}

/**
 * Every tracked callable declaration in the program, keyed by the symbol
 * `nameOfCallable` resolves for it -- built once, over EVERY declaration
 * (not only the census's own unannotated-parameter candidates), because a
 * selector can return, or a constructor can publish, a callable whose own
 * parameters are fully typed and irrelevant to this census except as the
 * far end of an alias chain leading to one that is not.
 */
export const indexNamedCallables = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability
): ReadonlyMap<ts.Symbol, ts.SignatureDeclaration> => {
  const bySymbol = new Map<ts.Symbol, ts.SignatureDeclaration>()
  const visit = (node: ts.Node): void => {
    if (isTrackedCallable(node)) {
      const name = nameOfCallable(node)
      const symbol = name && checker.getSymbolAtLocation(name)
      if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, node)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visit)
  return bySymbol
}

/**
 * The two shapes of alias VALUE FLOW this module makes sound: a function
 * published under a member, and a function bare-returned from a selector.
 * Both maps are keyed by a real checker symbol or a real declaration --
 * never by a name string, which is how a member on one class could
 * otherwise be confused with a same-spelled member on an unrelated one.
 *
 * Neither map depends on `parameter-bindings.ts`'s own fixpoint: which
 * functions get BOUND changes round to round, but which functions are
 * PUBLISHED where is a fact about the program's syntax and its symbols, settled
 * once the checker exists. Building this once, outside the round loop, is
 * sound for the same reason `overridesOfBaseMethod` there is built once.
 */
export interface AliasEvidence {
  /**
   * Function declarations published under a resolvable member symbol.
   * `this.setValue = setValueV3f` (and `_this.shadowMap = shadowMap`, and
   * every other `<propertyAccess> = <name>` assignment) records the
   * checker's own symbol for `setValue` mapping to `setValueV3f`'s
   * declaration. Multiple functions can publish under the SAME symbol --
   * a switch inside one constructor assigning different setters to
   * `this.setValue` in different branches -- and every one of them is kept:
   * each receives the evidence a later call attributes, and if their
   * existing evidence then disagrees, the ordinary `call-sites-disagree`
   * refusal fires, same as any other conflicting evidence.
   */
  readonly publishedUnderMember: ReadonlyMap<ts.Symbol, ReadonlySet<ts.SignatureDeclaration>>
  /**
   * Function declarations bare-returned from a selector, keyed by the
   * selector's OWN declaration. `getSingularSetter`'s switch returning
   * `setValueV1f`/`setValueV2f`/`setValueV3f`/`setValueV4f` across its
   * cases records all four against `getSingularSetter`'s declaration.
   */
  readonly returnedFrom: ReadonlyMap<ts.SignatureDeclaration, ReadonlySet<ts.SignatureDeclaration>>
}

export const emptyAliasEvidence: AliasEvidence = { publishedUnderMember: new Map(), returnedFrom: new Map() }

const EMPTY_CALLABLES: ReadonlySet<ts.SignatureDeclaration> = new Set()

export const indexAliasEvidence = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  namedCallables: ReadonlyMap<ts.Symbol, ts.SignatureDeclaration>
): AliasEvidence => {
  const publishedUnderMember = new Map<ts.Symbol, Set<ts.SignatureDeclaration>>()
  const returnedFrom = new Map<ts.SignatureDeclaration, Set<ts.SignatureDeclaration>>()
  const record = <K>(map: Map<K, Set<ts.SignatureDeclaration>>, key: K, values: ReadonlySet<ts.SignatureDeclaration>): void => {
    if (values.size === 0) return
    const existing = map.get(key)
    if (existing) for (const value of values) existing.add(value)
    else map.set(key, new Set(values))
  }
  /** The function a bare identifier names, via the checker's own symbol -- never its spelling. */
  const namedCallableOf = (expression: ts.Expression): ts.SignatureDeclaration | null => {
    if (!ts.isIdentifier(expression)) return null
    const symbol = checker.getSymbolAtLocation(expression)
    const direct = symbol ? namedCallables.get(symbol) : undefined
    if (direct) return direct
    // A shorthand property has a property symbol at its name, while the
    // callable value is the local symbol behind that property.  Ask the
    // checker for that value symbol so `{ method }` records the same callable
    // publication as `{ method: method }`.
    const parent = expression.parent
    if (ts.isShorthandPropertyAssignment(parent)) {
      const valueSymbol = checker.getShorthandAssignmentValueSymbol(parent)
      return valueSymbol ? (namedCallables.get(valueSymbol) ?? null) : null
    }
    return null
  }
  /**
   * Every function `expression` could evaluate to: a written callable,
   * a bare name, or a call straight
   * through a known selector -- `getSingularSetter( type )`, resolved by
   * the CHECKER's own attribution, never this module's. `this.setValue =
   * getSingularSetter( activeInfo.type )` is the real idiom this exists
   * for: the member is published not with a single named function but with
   * whichever one the selector call itself picks, and the two shapes
   * compose -- a member publication whose right side is a selector call
   * publishes the WHOLE returned set under that member, one pass after
   * `returnedFrom` has settled it for the selector.
   */
  const callablesOf = (expression: ts.Expression): ReadonlySet<ts.SignatureDeclaration> => {
    // A callable written directly into a member is its exact allocation
    // declaration, just as a named callable assigned there is. Omitting
    // these values loses every later member-call argument from their
    // parameter census despite knowing the member's publication identity.
    if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return new Set([expression])
    const named = namedCallableOf(expression)
    if (named) return new Set([named])
    if (ts.isCallExpression(expression)) {
      const selector = checker.getResolvedSignature(expression)?.declaration
      const returned = selector && returnedFrom.get(selector as ts.SignatureDeclaration)
      if (returned) return returned
    }
    return EMPTY_CALLABLES
  }
  // Pass 1: every selector's returned set, so pass 2 can already consult it
  // for a member published from a selector CALL rather than a bare name.
  const visitReturns = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const callable = namedCallableOf(node.expression)
      // A `return` belongs to its nearest enclosing function-like ancestor by
      // construction -- syntax cannot let it skip over a nested one -- so
      // this is exactly the declaration the reference above is binding-only
      // FOR, no separate containment walk needed.
      const enclosing = ts.findAncestor(node, isTrackedCallable)
      if (callable && enclosing) record(returnedFrom, enclosing as ts.SignatureDeclaration, new Set([callable]))
    }
    ts.forEachChild(node, visitReturns)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visitReturns)
  // Pass 2: every member publication, now free to resolve a selector call
  // on the right side through the completed `returnedFrom`.  Object
  // literals need the same treatment as `receiver.member = callable`:
  // factories such as WebGLState return a record whose properties are the
  // local forwarding functions.  The property symbol is the checker-owned
  // identity that later member calls expose, so recording it here keeps the
  // alias path generic and does not depend on the property's spelling.
  const visitPublications = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const callables = callablesOf(node.right)
      if (callables.size > 0) {
        const memberSymbol = checker.getSymbolAtLocation(node.left.name)
        if (memberSymbol) record(publishedUnderMember, memberSymbol, callables)
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
        const callables = callablesOf(node.initializer)
        // The symbol at an object-literal key is the declaration-local
        // property symbol.  Reads use the property symbol from the inferred
        // object type, so use that same stable identity for both sides.
        const memberSymbol = checker.getTypeAtLocation(node.parent).getProperty(name.text)
        if (memberSymbol && callables.size > 0) record(publishedUnderMember, memberSymbol, callables)
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const callables = callablesOf(node.name)
      // The shorthand value and the inferred object property have distinct
      // symbol objects. Ask the object literal's apparent type for the
      // PROPERTY symbol that later member calls resolve to.
      const memberSymbol = checker.getTypeAtLocation(node.parent).getProperty(node.name.text)
      if (memberSymbol && callables.size > 0) record(publishedUnderMember, memberSymbol, callables)
    }
    ts.forEachChild(node, visitPublications)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visitPublications)
  return { publishedUnderMember, returnedFrom }
}

/**
 * The type a node holds according to every authority in the program, checker
 * included.
 *
 * The binding census answers `null` for "nothing here improves on the
 * checker's answer", which is the safe default for the census but a trap for
 * its readers: it makes consulting the census OPTIONAL. A consumer that simply
 * calls `checker.getTypeAtLocation` gets a plausible type, no error, and no
 * indication that a better answer already existed one call away. That is not a
 * hypothetical -- it is the single most common defect this compiler has had.
 * `signatureOf` asked the census for a signature's parameters and not its
 * result; `memberOf` had the census threaded into its own module and never
 * called it; the array-element consumer asked only about `never` and not
 * `any`. Each was a few lines, each cost hundreds of boxed carriers, and each
 * looked locally correct.
 *
 * So the rule is: a consumer asks THIS, not the checker. The checker is an
 * input to the census, not an alternative to it, and the fallback belongs in
 * one place rather than being rewritten -- or forgotten -- at every call site.
 *
 * A site that genuinely wants the checker's own answer wants a different
 * question than this one ("what did the program STATE here", for a stated
 * annotation, versus "what does this hold"), and should say so in its own
 * words at the call rather than reaching past this by habit.
 */
export const censusedTypeAt = (
  checker: ts.TypeChecker,
  census: { readonly typeAt: (node: ts.Node) => ts.Type | null },
  node: ts.Node
): ts.Type => census.typeAt(node) ?? checker.getTypeAtLocation(node)

/**
 * The synthesized-union arms a write-set census resolved for a cell, answered
 * at the DECLARATION and at every READ of it alike.
 *
 * A cell whose writes disagree DISJOINTLY resolves to a union rather than a
 * refusal (see `disjointUnionMembersOf`), and that answer has to travel as an
 * arm LIST because `ts.TypeChecker.getUnionType` is not public -- so it cannot
 * ride in a census's `typeAt`, and each census publishes it through a second
 * channel, `unionArmsAt`, for `structural.ts` to intern.
 *
 * Every one of those channels was written as `ts.isParameter(node) ? arms.get(
 * node) : null` (and the variable/field equivalents), which answers for the
 * declaration NODE and for nothing else. That is the two-authorities defect
 * this compiler keeps rediscovering, in its quietest possible form: the
 * declaration got the union, and every ordinary reference to the cell -- an
 * identifier one line down -- fell through to the checker's own `any` and
 * boxed. Nothing reported a disagreement, because the second authority
 * answered `null`, and `null` is exactly how a census says "the checker's
 * answer stands".
 *
 * Measured on the three.js app: **176 top-level `dynamic` carriers sat on identifiers
 * reading a parameter the census had already resolved** -- 104 + 57 + 15,
 * the three synthesized-union parameters in the renderer's object walks, to
 * the unit. Answering here instead swapped exactly 171 `dynamic` carriers for
 * 171 `tagged-union` ones (a carrier kind the same program already selected
 * 2040 times), with `ops` unchanged and 92 FEWER unmet obligations.
 *
 * No flow narrowing is discarded by answering at a read, which is the one
 * thing that could make this unsound and the reason a census's `typeAt` needs
 * an equality guard for its ordinary bindings: a synthesized union arises only
 * where the declaration's own checker type is `any`, and `any` carries no
 * narrowing for a reference to report differently.
 *
 * `declarations.length === 1` is the same soleness test every resolver in this
 * module applies -- a name with two declarations is two cells, and answering
 * for either would be picking one.
 */
export const synthesizedUnionArmsAt = <D extends ts.Declaration>(
  checker: ts.TypeChecker,
  node: ts.Node,
  arms: ReadonlyMap<D, readonly ts.Type[]>,
  owns: (declaration: ts.Declaration) => declaration is D = ts.isParameter as unknown as (declaration: ts.Declaration) => declaration is D
): readonly ts.Type[] | null => {
  if (owns(node as ts.Declaration)) return arms.get(node as unknown as D) ?? null
  if (!ts.isIdentifier(node)) return null
  const declarations = checker.getSymbolAtLocation(node)?.declarations
  const declaration = declarations && declarations.length === 1 ? declarations[0] : undefined
  return declaration && owns(declaration) ? (arms.get(declaration) ?? null) : null
}
