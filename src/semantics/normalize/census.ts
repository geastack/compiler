import ts from 'typescript'
import { isAmbientDeclaration } from '../ambient.js'
import type { NamespacePathCensus } from './namespace-paths.js'
import {
  arrayAssignmentWriteTargetOf,
  isArrayAssignmentPatternElement,
  isAssignmentPattern,
  isObjectAssignmentElement,
  objectAssignmentElementOfTarget
} from './assignment-patterns.js'
import type { NodeId, OperationFamily } from '../../identity/ids.js'
import { regionId } from '../../identity/ids.js'
import type { SemanticCaller } from '../model/operands.js'
import type { SemanticRegion } from '../model/graph.js'
import { forEachEvaluationChild } from './evaluation-order.js'
import { enclosingCallIfCallee } from './producers/erasure.js'
import { rootSpecialization, type IdentityTable, type SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'
import type { ProgramReachability } from './reachability.js'

/**
 * The census.
 *
 * Before anything is normalized, every syntactic site in the program is
 * enumerated and assigned to a family. This is what makes "not installed"
 * measurable: a family that publishes nothing still has to account for every
 * candidate it saw. Without the census, a producer that silently skips a
 * construct is indistinguishable from a program that does not contain it.
 *
 * The census assigns families from ECMAScript syntax kinds only. It does not
 * look at names, and it does not look at what a call resolves to -- that is
 * proof, and proof comes later.
 */

export interface CensusCandidate {
  readonly node: ts.Node
  readonly id: NodeId
  readonly family: OperationFamily
  readonly caller: SemanticCaller
  /** Reachability requires this class's shape but no runtime definition. */
  readonly classLayoutOnly?: boolean
  /**
   * Which monomorphized copy of its enclosing generic this candidate belongs
   * to; empty when it is not inside one.
   *
   * A candidate carries this rather than being looked up from its node, because
   * one node produces one candidate per copy and the node cannot say which of
   * them is being asked about. Every consumer that needs a type for this
   * candidate needs the path with it: `T` is `number` in one copy and `string`
   * in the next, and the node is identical in both.
   */
  readonly specialization: SpecializationPath
  /**
   * This candidate's position in its caller's evaluation, counted in the order
   * the walk reaches it.
   *
   * Only the walk knows this. A per-producer counter cannot: producers run
   * family by family, so its numbers record which family published when, not
   * which operation runs first. The ordinal orders *siblings*, whose document
   * order really is their evaluation order; an operation and the operands it
   * consumes are ordered by the dependency between them, which is stronger
   * than any ordinal and needs no help from one.
   *
   * Operations minted from one candidate share its ordinal, and their relative
   * order travels on the evaluation edges their producer publishes -- the only
   * authority that knows an object literal's properties install left to right.
   */
  readonly evaluationOrdinal: number
}

export interface ProgramCensus {
  readonly candidates: readonly CensusCandidate[]
  readonly regions: ReadonlyMap<string, SemanticRegion>
  readonly byFamily: ReadonlyMap<OperationFamily, readonly CensusCandidate[]>
}

/**
 * The family a syntax kind belongs to.
 *
 * `null` means the node is not itself an operation -- a type annotation, a
 * modifier, a token. Returning `null` is different from returning a family and
 * then failing to normalize it: the first says "there is nothing here", the
 * second says "there is something here I could not model", and only the second
 * is a blocker.
 */
/**
 * Whether an identifier is a value reference rather than a name.
 *
 * `obj.foo`, `{ foo: 1 }`, `class C`, and `import { foo }` all contain an
 * identifier that never evaluates: it names something. Censusing those as
 * references would inflate the reference family with candidates no producer can
 * ever publish, and an inflated census is exactly what makes "not installed"
 * stop meaning anything.
 */
/**
 * Whether an identifier is an intrinsic JSX tag rather than a value reference.
 *
 * JSX's grammar decides this, and it decides it from the spelling: a
 * lowercase-initial identifier in tag position names an intrinsic element,
 * anything else resolves as a value. This is the same kind of authority a
 * string literal's characters carry -- the tag is data the language reads --
 * and it is why the rule can be stated here without consulting the checker.
 */
const isIntrinsicJsxTagName = (node: ts.Identifier | ts.PrivateIdentifier): boolean => {
  const parent = node.parent
  if (!parent) return false
  const inTagPosition =
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node
  if (!inTagPosition || !ts.isIdentifier(node)) return false
  const first = node.text.charAt(0)
  return first === first.toLowerCase() && first !== first.toUpperCase()
}

/**
 * Whether an identifier resolves a value out of a scope.
 *
 * Exported because it is an authority, not a helper: the census uses it to
 * decide which identifiers become reference candidates, and `frontend.ts`'s
 * ambient-host walk uses the same answer to decide which identifiers name a
 * cell a host owns. Two walks with two rules would disagree exactly on the
 * awkward cases -- a JSX tag, an import specifier, a property key -- and each
 * disagreement is a binding one layer thinks exists and the other does not.
 */
export const isValueReference = (node: ts.Identifier | ts.PrivateIdentifier, paths: NamespacePathCensus): boolean => {
  if (objectAssignmentElementOfTarget(node)) return false
  const parent = node.parent
  if (!parent) return false
  // The member half of a property access is a key, not a reference. The object
  // half is a reference and reaches this function separately.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  // The object half of `Debug.x` when `Debug` is a source namespace is a path
  // segment, not a read (`namespace-paths.ts`) -- but only when the whole
  // access IS a path or a qualified member. An access that resolves to no
  // member keeps its ordinary shape, receiver read included.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    (paths.isPath(parent) || paths.memberSymbolOf(parent) !== null)
  ) {
    return false
  }
  if (ts.isQualifiedName(parent)) return false
  // A bare type reference (`: GeaJsxElement`, `Array<T>`'s `T`) names a type,
  // not a value: TypeScript keeps the type and value namespaces separate, and
  // this identifier is never looked up against a value-holding scope. A
  // dotted reference's own name half is already excluded above via
  // `isQualifiedName`; this is the same fact for the one-segment case, where
  // the identifier's parent is the `TypeReferenceNode` itself rather than a
  // `QualifiedName` link inside one. Without this, a walk that (unlike the
  // census's own, which skips `TypeNode` subtrees outright) descends into
  // type annotations sees `GeaJsxElement` in `function Image(...):
  // GeaJsxElement` as a value read, mints a phantom host-object binding keyed
  // by the interface's bare name, and a later `native-handle` derived from it
  // spells a `gea_native_protocol_GeaJsxElement_v1` tag `gea_runtime.h` never
  // declares -- a program that certifies and then fails in clang.
  if (ts.isTypeReferenceNode(parent) && parent.typeName === node) return false
  if (ts.isMetaProperty(parent)) return false
  // A label is resolved against enclosing labeled statements, not against a
  // binding, so it is not a reference to anything a scope holds.
  if (ts.isLabeledStatement(parent) && parent.label === node) return false
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
    return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  // An intrinsic JSX tag is data, not a name: `<view/>` reads nothing from any
  // scope, and the identifier's own symbol is the *property signature* on the
  // JSX namespace's `IntrinsicElements`, which is a type-level member with no
  // value cell behind it. Censusing it as a reference makes the element read a
  // binding the program never introduces. A capitalised or dotted tag is the
  // opposite -- it really does resolve a value -- and stays a reference; the
  // element producer states the same rule, and both read it from the tag's own
  // spelling because that is where the JSX grammar puts it.
  if (isIntrinsicJsxTagName(node)) return false
  // A JSX attribute name is a property key, exactly as a property assignment's
  // name is.
  if (ts.isJsxAttribute(parent) && parent.name === node) return false
  // `{ x }` is the one place a name and a read are the same identifier: the
  // shorthand really does evaluate `x`, so dropping it would lose a real read.
  if (ts.isShorthandPropertyAssignment(parent)) return true
  // `export default foo` READS `foo`. ECMA-262 spells that production as an
  // `AssignmentExpression` (§16.2.3), evaluated once during module evaluation,
  // and the module's `*default*` binding is initialized from the value it
  // produces -- an ordinary read, no different from `const d = foo`.
  //
  // TypeScript nevertheless reports the identifier as the ExportAssignment's
  // own NAME (`getNonAssignedNameOfDeclaration` returns `expression` when it is
  // an identifier), because the checker needs an alias symbol there for CJS
  // interop. That is a fact about the type system's naming, not about what
  // runs, and the declaration-name rule at the end of this function -- written
  // for `let x = 1`, where the name really is not read -- would otherwise
  // silently absorb it: the identifier gets no family, `citeExpressionResult`
  // reports the expression as unmodelled, and the whole module is blocked with
  // "expression of syntax kind Identifier has no normalized family". Every
  // node-compat builtin ends in `export default <namespace object>`, so both
  // `node:http` and `node:events` failed on exactly this line.
  if (ts.isExportAssignment(parent) && parent.expression === node) return true
  // In `const { a: b } = o`, `a` is the key read from `o` and `b` is the binding.
  // Only `b` is what `getNameOfDeclaration` reports, so `a` is excluded here.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false
  if (ts.isEnumMember(parent) && parent.name === node) return false
  // The name of a declaration is the thing being declared. `let x = 1` binds
  // `x`; it does not read it, and treating it as a read would invent an
  // evaluation that never happens.
  // `ts.isDeclaration` is checker-internal; `getNameOfDeclaration` is the public
  // answer to the same question and returns nothing for a non-declaration.
  return ts.getNameOfDeclaration(parent as ts.Declaration) !== node
}

/**
 * Whether `node` is a plain identifier used DIRECTLY as a for-of/for-in loop's
 * own head, with no `var`/`let`/`const` of its own -- `var v; for (v of xs)`,
 * where `v` is declared elsewhere and merely reused.
 *
 * ECMA-262's `ForIn/OfStatement : for ( LeftHandSideExpression of
 * AssignmentExpression )` never evaluates this position as a value -- there is
 * no `GetValue` step, only `PutValue`, performed once per iteration from the
 * loop's own `IteratorStep`/enumerate step (`ForOfBodyEvaluation`/
 * `ForIn/OfHeadEvaluation`). This is the write-target twin of
 * `arrayAssignmentWriteTargetOf`, for the one shape that predicate does not
 * cover: a single identifier rather than an array pattern's element.
 *
 * Without this exclusion the identifier fell through to `isValueReference`'s
 * default rule (`getNameOfDeclaration` finds no declaration at this position,
 * so it answered "yes, a reference"), which censused it as a value READ the
 * loop never performs, and left the actual per-iteration write with no
 * producer at all: `gating.ts`'s own `visitHere` already reserves the
 * `iteration` scope for exactly this write (its comment names "the
 * `VariableDeclarationList` holding `value`'s own declaration, or a bare
 * assignment target" as the two shapes `node.initializer` can be), waiting on
 * a producer that never existed. `producers/bindings.ts`'s
 * `contributeForOfLoopHeadWrite` is that producer, keyed by this same family.
 *
 * A property or element access loop head (`for (obj.p of xs)`, `for (arr[i]
 * of xs)`) is a different, earlier-classified shape (`property` family, via
 * the `PropertyAccessExpression`/`ElementAccessExpression` arms above) and is
 * not covered here.
 */
const isForOfLoopHeadWriteTarget = (node: ts.Identifier | ts.PrivateIdentifier): boolean => {
  const parent = node.parent
  return parent !== undefined && (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node
}

/** A class body owns its members' lifecycle; an object literal allocates them. */
const hasClassLikeParent = (node: ts.Node): boolean => node.parent !== undefined && ts.isClassLike(node.parent)

/**
 * A function-like declaration that states a signature and no implementation.
 *
 * `ts.isPropertyDeclaration` is deliberately not covered: a property with no
 * initializer is not the same shape at all -- it still declares a field the
 * constructor installs -- so only the nodes that would otherwise allocate a
 * *callable* are asked.
 */
const isFunctionLikeWithoutBody = (node: ts.Node): boolean =>
  (ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)) &&
  node.body === undefined

/** An `abstract` member: a declaration the class states and every concrete subclass must implement. */
const isAbstractClassMember = (node: ts.Node): boolean =>
  hasClassLikeParent(node) &&
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword) ?? false)

export const familyOf = (node: ts.Node, paths: NamespacePathCensus): OperationFamily | null => {
  if (isObjectAssignmentElement(node)) return 'destructuring'
  if (objectAssignmentElementOfTarget(node)) return null
  // A simple array-assignment target (`[a, o.p, arr[0]] = ...`) is a WRITE,
  // never the ordinary read `reference`/`property` would census it as -- the
  // sibling pattern candidate below reads the position, and this candidate
  // only stores into it. Checked ahead of the property/reference rules for
  // the same reason `objectAssignmentElementOfTarget` is checked ahead of
  // them: an excluded node must never fall through to its ordinary family.
  if (arrayAssignmentWriteTargetOf(node)) return 'destructuring'
  // The default `=` and rest `...` WRAPPERS around such a target are not
  // themselves censused -- they exist only to be keyed by the array
  // pattern's own extraction/default operations (`destructuring.ts`'s
  // `contributeArrayAssignmentPattern`), the same way a binding pattern's
  // `BindingElement` node is a key rather than a computation.
  if (
    (ts.isSpreadElement(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)) &&
    isArrayAssignmentPatternElement(node)
  ) {
    return null
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
    // `import(...)` is a call in syntax only: its target is resolved at runtime
    // by the host, so treating it as an ordinary call would fabricate a target.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic-language'
    return 'invocation'
  }
  if (ts.isPropertyAccessExpression(node)) {
    // `Debug.log` in `Debug.log.trace(...)`: a path segment, no operation.
    if (paths.isPath(node)) return null
    // `Debug.assert`: a qualified binding reference -- the same family, and
    // the same `reference`/`binding` pair, that a bare `assert` written inside
    // the namespace body publishes. See `namespace-paths.ts`.
    if (paths.memberSymbolOf(node) !== null) return 'reference'
    return 'property'
  }
  if (ts.isElementAccessExpression(node)) return 'property'
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    if (isForOfLoopHeadWriteTarget(node)) return 'binding'
    return isValueReference(node, paths) ? 'reference' : null
  }
  // `this` resolves against the environment chain exactly as a name does --
  // `ResolveThisBinding` is `GetThisEnvironment().GetThisBinding()` -- so it is
  // a reference site, and censusing it as one is what gives the receiver a
  // published result instead of a placeholder every consumer has to invent.
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'reference'
  // `super` in `super.x`/`super.x(...)` resolves against the environment
  // chain the identical way `this` does: `GetSuperBase` reads the active
  // function's `[[HomeObject]]`, and a class method's home object is a fully
  // static fact -- the class's OWN declaration -- known without running
  // anything. Censusing it as a reference, the same family `this` gets, is
  // what lets `references.ts`'s reference producer publish a result for it
  // instead of every consumer inventing its own placeholder.
  //
  // Excluded when `super` is itself the bare callee of a call (`super(...)`):
  // that shape is grammar-restricted to a constructor and reads the base's
  // own *constructor*, a different question already answered a different way
  // (`invocations.ts`'s `superConstructorRead`, reached through
  // `ts.isCallExpression`'s branch above rather than this one). Syntax
  // permits `super` in exactly three positions -- `super(...)`, `super.x`,
  // `super[x]` -- and only the bare-callee one is that different question, so
  // this is the one shape carved back out rather than the other way round.
  if (node.kind === ts.SyntaxKind.SuperKeyword && enclosingCallIfCallee(node) === null) return 'reference'
  // A formal parameter introduces a binding, exactly as a variable declaration
  // does; the only difference is where its value comes from. Leaving it out of
  // the census makes every parameter read a read of a cell nothing declared,
  // which is invisible to every later layer -- the precise failure the census
  // exists to make measurable.
  if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) return 'binding'
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return isAssignmentPattern(node) ? 'destructuring' : 'allocation'
  }
  if (
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isRegularExpressionLiteral(node)
  ) {
    // A declaration with no body allocates nothing. `OrdinaryFunctionCreate`
    // needs a body to close over; what a bodiless declaration states is that a
    // function exists somewhere else -- either the host's, in `declare global
    // { function requestAnimationFrame(...) }`, or this program's own
    // implementation signature, in an overload set whose last member carries
    // the body.
    //
    // Censusing one anyway published a callable whose ABI declared parameters
    // no body could ever bind, and `projection/abi.ts` refused the program for
    // it -- naming the arity mismatch rather than the declaration that has no
    // body to bind them in. Five corpus apps were blocked that way.
    return isFunctionLikeWithoutBody(node) ? null : 'allocation'
  }
  if (ts.isClassDeclaration(node) || ts.isClassStaticBlockDeclaration(node) || ts.isConstructorDeclaration(node)) return 'class-lifecycle'
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    // A bodiless method is the same non-event a bodiless function is: an
    // overload signature, or a member an ambient class merely declares --
    // EXCEPT an `abstract` one, which is neither. `abstract check(value:
    // number): boolean` allocates nothing and still states a real class-
    // evaluation fact: the class declares this key, and every concrete
    // subclass must fill it. That declaration is what roots a dispatch family
    // (`targets/cpp/virtual-methods.ts`), and censusing it as nothing is why
    // `rules.map(r => r.describe())` over an abstract-typed array went through
    // a boxed dynamic property read that aborted at runtime.
    if (isFunctionLikeWithoutBody(node)) return isAbstractClassMember(node) ? 'class-lifecycle' : null
    // The same syntax kinds appear in an object literal, where they are part of
    // building one object rather than steps of class evaluation.
    return hasClassLikeParent(node) ? 'class-lifecycle' : 'allocation'
  }
  if (
    ts.isBinaryExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isConditionalExpression(node) ||
    // A `TemplateExpression` is a string concatenation -- EXCEPT the one under a
    // tagged template, which is not evaluated as a string at all. ECMA-262
    // 13.3.11.1 hands the tag the segments and the raw substitution values;
    // nothing calls `ToString` on a substitution. Censusing it as a computation
    // anyway is not merely dead work: a substitution whose `ToString` throws
    // (a symbol, an object with a throwing `toString`) would throw at a site
    // the language says never stringifies it. `tagged-template.ts` reads the
    // spans' expressions directly, so nothing is lost by leaving this node to
    // its tagged parent.
    (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) ||
    ts.isTypeOfExpression(node) ||
    ts.isVoidExpression(node) ||
    ts.isDeleteExpression(node)
  ) {
    return 'computation'
  }
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node) ||
    ts.isLabeledStatement(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    node.kind === ts.SyntaxKind.DebuggerStatement
  ) {
    return 'control'
  }
  // JSX element syntax is the only surface in the language whose meaning comes
  // from declarations rather than from the specification, so it gets its own
  // family instead of being folded into allocation or invocation -- neither of
  // which is true of it under every JSX namespace a program may supply.
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return 'element'
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) return 'destructuring'
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return 'protocol'
  if (ts.isCatchClause(node)) return 'boundary'
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return 'declaration-lifecycle'
  return null
}

/**
 * Whether this node is an arrow function's expression body.
 *
 * `EvaluateBody` for an `ExpressionBody` is `Return ? Evaluation of
 * AssignmentExpression`: the return is part of the arrow's call, and no
 * `ReturnStatement` exists to census. A concise body is the one place in the
 * language where a single node both produces a value and carries it out of the
 * call.
 */
const isConciseArrowBody = (node: ts.Node): boolean =>
  node.parent !== undefined && ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node)

/**
 * Whether this node is a class field's initializer expression.
 *
 * `ClassFieldDefinitionRecord`'s initializer is a function whose whole body is
 * `Return ? Evaluation of the initializer` -- the same implicit return a
 * concise arrow body performs, for the same reason: the value has to leave the
 * call, and no `ReturnStatement` exists to census.
 */
export const isFieldInitializerBody = (node: ts.Node): boolean =>
  node.parent !== undefined && ts.isPropertyDeclaration(node.parent) && node.parent.initializer === node

/** Whether `node` is `ancestor` or lies inside it. */
const isWithin = (node: ts.Node, ancestor: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true
  return false
}

/**
 * Whether this node is a parameter property: `constructor(readonly name: T)`.
 *
 * TypeScript's own predicate, not a re-derivation of it -- the modifier set
 * that makes a parameter also declare a member is the language's rule, and
 * spelling it a second time here would be a second authority over it.
 */
export const isParameterProperty = (node: ts.Node): node is ts.ParameterPropertyDeclaration =>
  node.parent !== undefined && ts.isParameterPropertyDeclaration(node, node.parent)

/**
 * Every family a node carries, in evaluation order.
 *
 * Almost every node carries one. A concise arrow body and a field initializer
 * carry two -- the expression and the implicit return -- and they stay
 * distinguishable because identity is keyed by `(node, family, ordinal)`, so
 * neither can be mistaken for the other by a consumer citing one of them.
 * Dropping the second is what made an arrow function evaluate its body and
 * then return nothing.
 *
 * A parameter property carries two for a third reason: it IS two declarations
 * written as one. `constructor(readonly name: string)` declares a formal
 * parameter -- the `binding` every parameter is -- and an instance member the
 * constructor assigns that parameter into. The second half is class evaluation,
 * so it is `class-lifecycle`, and its caller is the constructor the parameter
 * sits in, which is exactly where the assignment belongs.
 */
export const familiesOf = (node: ts.Node, paths: NamespacePathCensus): readonly OperationFamily[] => {
  const primary = familyOf(node, paths)
  if (isParameterProperty(node)) return primary ? [primary, 'class-lifecycle'] : ['class-lifecycle']
  // A class EXPRESSION is an allocation (its value is the constructor object)
  // and, when it extends something, one step of class evaluation too: the
  // heritage read `ClassDefinitionEvaluation` performs. Without that event the
  // projection saw no base for `const D = class extends B {}`, and an
  // inherited field read on a `D` instance went through the dynamic sidecar
  // and aborted. The declaration form publishes the same event from
  // `class-lifecycle.ts`'s `contributeClass`; this is the expression's half.
  // A written constructor is the other lifecycle step an expression shares
  // with a declaration: its callable allocation is what gives the body a
  // stated convention (`class-lifecycle.ts`'s `writtenConstructorAllocationOf`).
  if (
    ts.isClassExpression(node) &&
    (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ||
      node.members.some((member) => ts.isConstructorDeclaration(member) && member.body !== undefined))
  ) {
    return primary ? [primary, 'class-lifecycle'] : ['class-lifecycle']
  }
  if (!isConciseArrowBody(node) && !isFieldInitializerBody(node)) return primary ? [primary] : []
  // A concise body that is itself a control expression (`await x`, `yield x`)
  // would collide with its own implicit return at one identity; the return is
  // what the arrow needs, and the census refuses to publish two operations that
  // cannot be told apart rather than silently keeping one of them.
  if (primary === 'control') return ['control']
  return primary ? [primary, 'control'] : ['control']
}

/** The nearest enclosing function or region that executes this node. */
const callerOf = (
  node: ts.Node,
  identities: IdentityTable,
  regions: Map<string, SemanticRegion>,
  path: SpecializationPath
): SemanticCaller => {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return { kind: 'function', functionId: identities.functionIdOf(current, path) }
    }
    // A field initializer is a function, not a region: `ClassFieldDefinition`
    // creates one with `OrdinaryFunctionCreate` and calls it with the instance
    // as its receiver, once per construction. Modelling it as a region would
    // leave it with no calling convention to declare that receiver, and the
    // `this` its body reads would have no frame slot to come from.
    //
    // Only the INITIALIZER is that function. A computed key (`[incomingKey]:
    // T`) is evaluated by ClassDefinitionEvaluation itself, in the class
    // body's scope, before any instance exists; attributing its reference to
    // the field function handed a field WITHOUT an initializer -- for which
    // `class-lifecycle.ts` correctly allocates no function object -- an
    // operation owned by a function that has no allocation, and ABI
    // projection refused the whole program ("no function-object allocation
    // published a callable carrier"). `@hono/node-server`'s adapted
    // `LightRequest` declares exactly such a field. The key's owner is
    // whatever owns the class body, found by continuing the walk.
    if (ts.isPropertyDeclaration(current)) {
      if (current.initializer !== undefined && isWithin(node, current.initializer)) {
        return { kind: 'function', functionId: identities.functionIdOf(current, path) }
      }
      current = current.parent
      continue
    }
    // A static block executes in its own context too, and collapsing it into
    // the class body or the module body would lose the order in which class
    // evaluation runs it.
    if (ts.isClassStaticBlockDeclaration(current)) {
      const id = regionId(identities.declarationIdOf(current, path), 'static-block')
      if (!regions.has(id)) {
        regions.set(id, { id, role: 'static-block', bodyNode: identities.nodeIdOf(current, path), caller: null })
      }
      return { kind: 'region', regionId: id }
    }
    current = current.parent
  }
  const file = node.getSourceFile()
  const id = regionId(identities.nodeIdOf(file), 'module-body')
  if (!regions.has(id)) regions.set(id, { id, role: 'module-body', bodyNode: identities.nodeIdOf(file), caller: null })
  return { kind: 'region', regionId: id }
}

const callerKey = (caller: SemanticCaller): string => (caller.kind === 'function' ? `fn|${caller.functionId}` : `region|${caller.regionId}`)

export const censusProgram = (
  files: readonly ts.SourceFile[],
  identities: IdentityTable,
  reachable: ProgramReachability,
  specializations: SpecializationCensus,
  namespacePaths: NamespacePathCensus
): ProgramCensus => {
  const candidates: CensusCandidate[] = []
  const regions = new Map<string, SemanticRegion>()
  const ordinals = new Map<string, number>()
  const nextOrdinal = (caller: SemanticCaller): number => {
    const key = callerKey(caller)
    const ordinal = ordinals.get(key) ?? 0
    ordinals.set(key, ordinal + 1)
    return ordinal
  }

  for (const file of files) {
    /**
     * Census this node's own candidates.
     *
     * `callerPath` is the path of the scope that *holds* this node, which is
     * not always the path its children are walked under: a generic declaration
     * is held by an unspecialized scope while everything inside it belongs to
     * one copy.
     */
    const record = (node: ts.Node, callerPath: SpecializationPath, path: SpecializationPath): void => {
      const families = familiesOf(node, namespacePaths)
      if (families.length === 0) return
      const caller = callerOf(node, identities, regions, callerPath)
      const owner = ts.isClassDeclaration(node) ? node : ts.isClassDeclaration(node.parent) ? node.parent : null
      for (const family of families) {
        candidates.push({
          node,
          id: identities.nodeIdOf(node, path),
          family,
          caller,
          ...(owner && reachable.classIsLayoutOnly(owner) ? { classLayoutOnly: true } : {}),
          evaluationOrdinal: nextOrdinal(caller),
          specialization: path
        })
      }
    }

    const visit = (node: ts.Node, path: SpecializationPath): void => {
      // Ambient module/global blocks describe host values; none of their children execute.
      if (ts.isModuleDeclaration(node) && isAmbientDeclaration(node)) return
      // A type annotation contains no operations: nothing in it evaluates. The
      // one exception is a heritage clause, whose expression really is evaluated
      // at class definition time, so it is descended into rather than skipped.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
      // An overload signature -- a bodiless, non-abstract function or method
      // -- is not a runtime event (`familyOf` already answers `null` for the
      // node itself), and nothing UNDER it evaluates either: its parameters
      // bind nothing, and a computed name such as `[Symbol.iterator]` is
      // evaluated once, for the implementation that follows. Descending into
      // it minted that key's `Symbol.iterator` read as an operation whose
      // caller was the signature's own function id -- a function no
      // allocation ever publishes a carrier for -- and `projection/abi.ts`
      // refused the program at the signature with "no function-object
      // allocation published a callable carrier" (node-compat's
      // URLSearchParams `*[Symbol.iterator]` overload pair;
      // `test/runtime/class-symbol-iterator-generator-overload.ts`). A
      // named overload had no child that evaluates, which is why it never
      // showed the same refusal.
      if (isFunctionLikeWithoutBody(node) && !isAbstractClassMember(node)) return
      // A static method nothing in the program NAMES. The class around it is
      // live -- its layout is what a live reference reaches -- but a body only
      // `C.m` can reach, with no `C.m` anywhere, is dead exactly as an
      // unreferenced top-level function is. `reachability.ts` is the one
      // authority on that, asked here for the same reason `statementsOf` is
      // asked below: so there is one answer and not two.
      if (reachable.memberIsPruned(node)) return
      // Monomorphization, as the census performs it: a generic declaration's
      // subtree is walked once per instantiation the program makes, with that
      // instantiation's ordinal pushed onto the path. Every identity minted
      // underneath is therefore per copy, which is what makes `T` answerable --
      // there is no longer one body with a hole in it, there are as many bodies
      // as the program has instantiations, each with a type in that position.
      //
      // A generic the program never instantiates is walked *not at all*. Its
      // body has no meaning until something fills the hole, and emitting one
      // copy with the hole still open is exactly the state this removes.
      //
      // Which node carries the copies is `genericSubjectOf`'s question, not
      // this walk's: `const f = <T>(...) => ...` keys them on the arrow while
      // the declaration naming it is what has to be recorded per copy, so the
      // fork is hoisted here and the arrow reached as a child finds itself
      // already inside its own copy. Forking it again would push a second entry
      // for the same owner and mint identities under a path no use site names.
      const holder = path[path.length - 1]
      if (holder !== undefined && holder.owner === node) {
        forEachEvaluationChild(node, (child) => visit(child, path))
        record(node, path, path)
        return
      }
      const subject = identities.genericSubjectOf(node as ts.Declaration)
      const copies = specializations.specializationsOf(subject)
      if (copies.length > 0) {
        for (const copy of copies) {
          const inner = [...path, { owner: subject, ordinal: copy.ordinal }]
          // Children first, then this node: the ordinal is an *evaluation*
          // index, and the generic's own allocation evaluates after whatever it
          // encloses is laid out.
          forEachEvaluationChild(node, (child) => visit(child, inner))
          record(node, path, inner)
        }
        return
      }
      // The other half of that rule, and the case a framework barrel makes
      // ordinary: `mount<RootComponent extends Component>` is in every app's
      // module graph, and the apps that never call it instantiate it never.
      // Walking it once anyway publishes a function-object allocation whose
      // carrier *is* the open hole, which representation then refuses -- one
      // uncalled generic in a shared module denied a whole program its
      // certificate. There is no such function in this program, so nothing is
      // recorded for it.
      if (specializations.isGeneric(subject)) return
      // Children first, then this node: the ordinal is an *evaluation* index,
      // and an expression's operands evaluate before the expression does. A
      // pre-order index says the opposite, and where the graph leaves two
      // operations unordered -- an assignment's store and whatever consumes the
      // assignment's value, say -- the tie would break in favour of the
      // consumer, scheduling a store after the `return` that reads it. Sibling
      // order is preserved either way, so statements still run in source order.
      // RequireObjectCoercible runs before any assignment target is evaluated.
      // Each element then publishes its own extraction and write in order.
      if (ts.isObjectLiteralExpression(node) && isAssignmentPattern(node)) {
        record(node, path, path)
        forEachEvaluationChild(node, (child) => visit(child, path))
        return
      }
      // GetIterator runs once, up front, before any element's target
      // reference is resolved or its default evaluated -- the array-pattern
      // twin of the object-pattern rule immediately above.
      if (ts.isArrayLiteralExpression(node) && isAssignmentPattern(node)) {
        record(node, path, path)
        forEachEvaluationChild(node, (child) => visit(child, path))
        return
      }
      forEachEvaluationChild(node, (child) => visit(child, path))
      record(node, path, path)
    }
    // The statements this program reaches, not the file: a declaration nothing
    // reaches has no meaning to census, exactly as an uninstantiated generic
    // above has none. `reachability.ts` is the one authority on which those
    // are, and every other whole-program walk asks the same one.
    for (const node of reachable.statementsOf(file)) visit(node, rootSpecialization)
  }

  const byFamily = new Map<OperationFamily, CensusCandidate[]>()
  for (const candidate of candidates) {
    const bucket = byFamily.get(candidate.family) ?? []
    bucket.push(candidate)
    byFamily.set(candidate.family, bucket)
  }

  return { candidates, regions, byFamily }
}
