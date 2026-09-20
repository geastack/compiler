import ts from 'typescript'
import { isScriptGlobalObjectPropertyDeclaration } from '../script-global-redefinition.js'
import { enclosingCallIfCallee, unwrapErasedExpression } from './erasure.js'
import { publishesShortCircuit } from './optional-chain.js'
import {
  operationId,
  regionId,
  semanticResultId,
  type OperationFamily,
  type OperationId,
  type SemanticResultId,
  type StructuralTypeId
} from '../../../identity/ids.js'
import type { PrimitiveFamily } from '../../model/coverage.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, pureEffects, throwingCompletion, type ConstantLiteral, type OperandSource } from '../../model/operands.js'
import type { BindingOperation, ReferenceOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import { familyOf } from '../census.js'
import type { NamespacePathCensus } from '../namespace-paths.js'
import type { ArgumentsObjectCensus } from '../arguments-objects.js'
import type { IdentityTable } from '../identities.js'
import type { ProducerContext } from '../producer-context.js'
import { bindingKindOf } from './binding-kind.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { valueSymbolAt } from '../unresolvable-names.js'
import type { UnresolvableNameCensus } from '../unresolvable-names.js'
import { argumentsObjectValueAt } from './bindings.js'
import { calleeAwareTypeAt, isAssignmentOperatorKind } from './shared.js'

const literalConstantOf = (expression: ts.Expression): { text: string; literal: ConstantLiteral } | null => {
  if (ts.isStringLiteralLike(expression)) return { text: expression.text, literal: 'string' }
  if (ts.isNumericLiteral(expression)) return { text: expression.text, literal: 'number' }
  if (expression.kind === ts.SyntaxKind.BigIntLiteral)
    return { text: (expression as ts.BigIntLiteral).text.slice(0, -1), literal: 'bigint' }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { text: 'true', literal: 'boolean' }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { text: 'false', literal: 'boolean' }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { text: 'null', literal: 'null' }
  // `undefined` is spelled as a name, but it is not a binding any program
  // reads: the global property is non-writable and non-configurable, so every
  // resolution of the unshadowed name yields the one value. Citing it as a
  // constant is what `null` already gets, and it is what lets `undefined as
  // unknown as T` -- the standard ambient-global guard -- publish a value at
  // all. A program that declares its *own* `undefined` is a different name;
  // `buildReference` refuses that one by name rather than letting this text
  // answer for it.
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return { text: 'undefined', literal: 'undefined' }
  return null
}

/** Whether a checker type explicitly has an `undefined` constituent. */
const includesUndefined = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) return true
  return type.isUnion() && type.types.some(includesUndefined)
}

/** Whether an equality operation directly compares this expression with `undefined`. */
const comparesWithUndefined = (context: ProducerContext, node: ts.Expression): boolean => {
  let inner: ts.Node = node
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
  ) {
    return false
  }
  const other = parent.left === inner ? parent.right : parent.right === inner ? parent.left : null
  return other !== null && (context.types.rawTypeAt(other).flags & ts.TypeFlags.Undefined) !== 0
}

/**
 * Keep an explicitly optional local's physical absence when this use has a
 * destination for it. TypeScript flow narrows `let value: T | undefined =
 * dictionary[key]` to `T` when `noUncheckedIndexedAccess` is off, because its
 * checker type for the initializer omits the missing-key `undefined`. The
 * property producer restores that absence and the cell therefore physically
 * holds `Optional<T>`; dereferencing it at a later optional return or
 * `!== undefined` test would discard the very absence the producer recovered.
 *
 * This does not suppress ordinary control-flow narrowing: only a use whose
 * contextual destination itself admits `undefined`, or which directly tests
 * for it, keeps the declaration's stated carrier. A use that requires `T`
 * continues to use the checker's narrowed answer and its existing presence
 * proof/conversion.
 */
const destinationPreservesDeclaredAbsence = (
  context: ProducerContext,
  node: ts.Identifier,
  declaration: ts.Declaration | null
): StructuralTypeId | null => {
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type === undefined) return null
  const declared = context.checker.getTypeAtLocation(declaration.name)
  if (!includesUndefined(declared)) return null
  const contextual = context.checker.getContextualType(node)
  if ((contextual === undefined || !includesUndefined(contextual)) && !comparesWithUndefined(context, node)) return null
  return context.types.typeAt(declaration)
}

export type ExpressionCitation =
  | {
      readonly kind: 'source'
      readonly source: OperandSource
      /** Present only for a name: the Reference Record, for an assignment target. */
      readonly reference?: SemanticResultId
    }
  /** No family was censused for this node, so no result exists to cite. */
  | { readonly kind: 'unmodelled'; readonly reason: string }

/**
 * Cite the result an expression's own family producer publishes for it, without
 * minting anything: `operationId`/`semanticResultId` are pure, so recomputing
 * the identity another producer will independently compute for the same node
 * is exactly how one operation's operand reaches another's result. The ordinal
 * is 0 because a node used purely to produce a value for someone else's operand
 * is never itself the target of an assignment, delete, or `in` test -- the one
 * thing (compound assignment, update expressions) that ever mints a second
 * operation from the same node happens at the node's own census candidate, not
 * at a citing site.
 */
/** The property whose installation completes an object literal, if it has one. */
const lastDataPropertyOf = (node: ts.ObjectLiteralExpression): ts.ObjectLiteralElementLike | null => {
  const data = node.properties.filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
  return data[data.length - 1] ?? null
}

/**
 * Which value of a `?.`-carrying link a citer wants.
 *
 * `expression` is what the source expression evaluates to -- the property on
 * one branch and `undefined` on the other -- and is what every ordinary
 * consumer means. `present` is the `[[Get]]`'s own answer, which exists only
 * inside the guard's present arm. An optional call is the one citer that needs
 * it: it *runs* in that arm, gated on the same guard, and the merge that makes
 * the `expression` value does not exist until both arms have joined, which is
 * after the call has already happened.
 */
export type CitedBranch = 'expression' | 'present'

/**
 * What `citeExpressionResult` needs beyond the syntax in front of it.
 *
 * It is a PREDICTOR: it names the result a producer will publish for an
 * expression without running that producer, so every fact it branches on has
 * to be one both sides can read. `identities` was the whole of that until
 * `arguments` -- whose citation depends on a question only the checker can
 * answer -- so the checker answers once in the frontend and both sides read
 * the same census.
 *
 * `ProducerContext` satisfies this structurally, so a producer passes itself.
 */
export interface CitationFacts {
  readonly identities: IdentityTable
  readonly argumentsObjects: ArgumentsObjectCensus
  readonly unresolvableNames: UnresolvableNameCensus
  /** Which property accesses are namespace paths or qualified members (`namespace-paths.ts`). */
  readonly namespacePaths: NamespacePathCensus
}

/**
 * Where an `arguments` reference site publishes its value.
 *
 * ONE rule, read by both sides: `buildArgumentsObjectReference` publishes at
 * this coordinate and `citeExpressionResult` cites it, and the publisher
 * checks its own minted answer against this function rather than trusting
 * that the two stayed in step. That check is the point -- a citation and a
 * publication that drift apart produce no error at all, only an operation
 * quietly withheld and, with it, every operation of the enclosing function.
 *
 * The shape depends on the phantom rest parameter's ordinal because
 * `argumentsObjectValueAt` publishes two shapes: at ordinal 0 the phantom's
 * own rest array IS the whole `arguments` object, and a single
 * `reference`/`parameter-value` operation carries it; at ordinal P > 0 the
 * object is P declared parameters concatenated with that tail, which takes an
 * array allocation the reference feeds, and the allocation is what a consumer
 * means by `arguments`.
 */
const argumentsObjectResultAt = (nodeId: ReturnType<IdentityTable['nodeIdOf']>, phantomOrdinal: number): SemanticResultId =>
  phantomOrdinal === 0
    ? semanticResultId(operationId(nodeId, 'reference', 0), 'value')
    : semanticResultId(operationId(nodeId, 'allocation', 0), 'value')

/**
 * Where a name with no binding anywhere publishes its value.
 *
 * ONE rule, read by both sides, exactly like `argumentsObjectResultAt` above:
 * `buildReference` publishes at this coordinate and `citeExpressionResult`
 * cites it. A name the checker resolves to no symbol has no cell, so
 * `GetValue` reads nothing and no `binding` operation exists to cite -- the
 * generic `family === 'reference'` path predicted one regardless, because it
 * reads syntax and the syntax is an identifier like any other.
 */
const unresolvableValueResultAt = (nodeId: ReturnType<IdentityTable['nodeIdOf']>): SemanticResultId =>
  semanticResultId(operationId(nodeId, 'reference', 0), 'value')

/** TypeScript's declarationless intrinsic `globalThis` publishes at the reference operation itself, like `this`. */
const globalThisValueResultAt = (nodeId: ReturnType<IdentityTable['nodeIdOf']>): SemanticResultId =>
  semanticResultId(operationId(nodeId, 'reference', 0), 'value')

export const citeExpressionResult = (
  expression: ts.Expression,
  facts: CitationFacts,
  branch: CitedBranch = 'expression'
): ExpressionCitation => {
  const identities = facts.identities
  const real = unwrapErasedExpression(expression)
  const literal = literalConstantOf(real)
  if (literal !== null) return { kind: 'source', source: { kind: 'constant', text: literal.text, literal: literal.literal } }
  // `this` publishes its value directly: `ResolveThisBinding` returns a value,
  // not a Reference Record, so there is no read to cite and nothing to assign
  // through.
  if (real.kind === ts.SyntaxKind.ThisKeyword) {
    const id = operationId(identities.nodeIdOf(real), 'reference', 0)
    return { kind: 'source', source: { kind: 'result', result: semanticResultId(id, 'value') } }
  }
  // `super` (in `super.x`/`super.x(...)`, never in the bare-callee `super(...)`
  // shape -- see `census.ts`'s own carve-out) publishes its value the same
  // direct way: `buildSuperReference` below mints the identical operation
  // identity this predicts, holding `this`'s own runtime value under the home
  // object's static type, so a member reached off it resolves starting one
  // prototype above `this`'s own class instead of at it.
  if (real.kind === ts.SyntaxKind.SuperKeyword) {
    const id = operationId(identities.nodeIdOf(real), 'reference', 0)
    return { kind: 'source', source: { kind: 'result', result: semanticResultId(id, 'value') } }
  }

  // `arguments` publishes its value directly too, and for the same reason as
  // `this`: the magic binding resolves to no declaration anywhere, so there is
  // no cell for `GetValue` to read and no `binding` operation any producer
  // could ever mint for it. The generic `family === 'reference'` path below
  // predicted one regardless -- it reads syntax, and the syntax is an
  // identifier like any other -- so every consumer of an `arguments` read
  // cited a result nothing publishes, and was withheld along with the rest of
  // the enclosing function. That is what made `Object3D.add`'s
  // `arguments.length` guard, and the eleven other `arguments` bodies in
  // three.js, compile to nothing at all.
  const argumentsOrdinal = facts.argumentsObjects.phantomOrdinalOf(real)
  if (argumentsOrdinal !== null) {
    return { kind: 'source', source: { kind: 'result', result: argumentsObjectResultAt(identities.nodeIdOf(real), argumentsOrdinal) } }
  }

  if (ts.isIdentifier(real) && facts.unresolvableNames.isIntrinsicGlobalThis(real)) {
    return { kind: 'source', source: { kind: 'result', result: globalThisValueResultAt(identities.nodeIdOf(real)) } }
  }

  // A name that resolves to no binding at all publishes its value directly,
  // for the same reason `arguments` does: there is no cell, so there is no
  // `GetValue` to mint a `binding` operation for. Three's feature detection is
  // full of these -- `typeof Float16Array !== 'undefined' && array instanceof
  // Float16Array`, and the same shape for `XRWebGLBinding`, `XRWebGLLayer` and
  // `__THREE_DEVTOOLS__` -- and every one of them cited a read nothing
  // published, withholding the guard and the operations around it.
  //
  // Reading such a name usually throws (`unresolvableThrows`), so nothing
  // downstream of this value is reachable -- except as `typeof`'s own operand
  // (`isTypeofOperand`, ECMA-262 13.5.1.2's carve-out: `typeof` returns
  // `"undefined"` for an unresolvable reference without ever calling
  // `GetValue`), where the value really is reached, as the constant
  // `undefined`. Either way this is honest rather than a fiction: the result
  // exists so the graph can be built and BOTH answers -- the throw, and the
  // one case that is not one -- are stated, not assumed.
  if (ts.isIdentifier(real) && facts.unresolvableNames.hasNoCell(real)) {
    return { kind: 'source', source: { kind: 'result', result: unresolvableValueResultAt(identities.nodeIdOf(real)) } }
  }

  // An object literal evaluates to its object only once every property is
  // installed, so what a consumer cites is the last install, not the bare
  // allocation. Citing the allocation would let `const o = { a: f() }` bind `o`
  // before `f()` runs -- precisely the read the temporal dead zone exists to
  // refuse -- because nothing would order the binding after the installs.
  // The allocation producer mints that install as a `property` operation on the
  // property's own node; the census routes no family to a PropertyAssignment,
  // so the family is stated here rather than looked up.
  const completing = ts.isObjectLiteralExpression(real) ? lastDataPropertyOf(real) : null
  const owner = completing ?? real

  const family = completing ? ('property' as OperationFamily) : familyOf(owner, facts.namespacePaths)
  if (!family) {
    return {
      kind: 'unmodelled',
      reason: `expression of syntax kind ${ts.SyntaxKind[real.kind]} has no normalized family to publish a citable result`
    }
  }
  // A name's *value* is what a consumer needs, and that is the binding read
  // GetValue publishes, not the Reference Record the resolution publishes.
  // Citing the reference would hand a consumer a place where it asked for a
  // value, and the two are not interchangeable at any layer below this one.
  if (family === 'reference') {
    const referenceId = operationId(identities.nodeIdOf(owner), 'reference', 0)
    const readId = operationId(identities.nodeIdOf(owner), 'binding', 0)
    return {
      kind: 'source',
      source: { kind: 'result', result: semanticResultId(readId, 'value') },
      // The reference itself, for a consumer that assigns rather than reads.
      reference: semanticResultId(referenceId, 'reference')
    }
  }
  // A postfix update evaluates to the value *before* the increment, and the
  // increment is what ordinal 0 publishes -- every writer cites it as the value
  // stored. The old value is the ToNumeric coercion the update producer mints
  // next, so a postfix consumer predicts ordinal 1 rather than 0.
  const ordinal = ts.isPostfixUnaryExpression(owner) ? 1 : 0
  const id = operationId(identities.nodeIdOf(owner), family, ordinal)
  // `a?.b` evaluates to the property when the receiver is present and to
  // `undefined` when it is not, and that merged value is the `short-circuit`
  // result. Citing `value` here would hand a consumer the property read alone,
  // which does not exist on one of the two branches -- the reader would be
  // scheduled in a block the writer never reaches.
  const role = publishesShortCircuit(owner) && branch === 'expression' ? 'short-circuit' : 'value'
  return { kind: 'source', source: { kind: 'result', result: semanticResultId(id, role) } }
}

const isDeclarationNamePosition = (node: ts.Node): boolean => {
  const parent = node.parent
  if (ts.isBindingElement(parent)) return parent.name === node || parent.propertyName === node
  if (ts.isVariableDeclaration(parent)) return parent.name === node
  if (ts.isParameter(parent)) return parent.name === node
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) return parent.name === node
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return parent.name === node
  if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) return parent.name === node
  if (ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) return parent.name === node
  if (ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) return parent.name === node
  if (ts.isEnumDeclaration(parent)) return parent.name === node
  if (ts.isEnumMember(parent)) return parent.name === node
  if (ts.isInterfaceDeclaration(parent)) return parent.name === node
  if (ts.isTypeAliasDeclaration(parent)) return parent.name === node
  if (ts.isModuleDeclaration(parent)) return parent.name === node
  if (ts.isTypeParameterDeclaration(parent)) return parent.name === node
  if (ts.isImportEqualsDeclaration(parent)) return parent.name === node
  return false
}

const isPropertyAssignmentKeyPosition = (node: ts.Node): boolean => {
  const parent = node.parent
  // Shorthand `{ x }` is excluded on purpose: its name is simultaneously the
  // key and a real reference to the local binding `x`, unlike `{ x: 1 }`'s key.
  return ts.isPropertyAssignment(parent) && parent.name === node
}

/**
 * An import's local name and an export's public label are never resolved by
 * looking anything up; a plain `export { x }`'s `x`, by contrast, *is* the
 * local reference (there is no separate `propertyName` to carry it), which is
 * why export specifiers are not treated symmetrically with import specifiers.
 */
const isNonReferenceSpecifierPosition = (node: ts.Node): boolean => {
  const parent = node.parent
  if (ts.isImportSpecifier(parent)) return parent.name === node || parent.propertyName === node
  if (ts.isExportSpecifier(parent)) return parent.propertyName !== undefined && parent.name === node
  if (ts.isImportClause(parent)) return parent.name === node
  if (ts.isNamespaceImport(parent)) return parent.name === node
  if (ts.isNamespaceExport(parent)) return parent.name === node
  return false
}

const isLabelPosition = (node: ts.Node): boolean => {
  const parent = node.parent
  if (ts.isLabeledStatement(parent)) return parent.label === node
  if (ts.isBreakOrContinueStatement(parent)) return parent.label === node
  return false
}

/**
 * Whether this name is the base of a chain link this compiler does not model.
 *
 * The base of a link that carries the `?.` itself is an ordinary read: `a` in
 * `a?.b` is evaluated unconditionally, and that read is precisely the guard the
 * short-circuit branches on. Refusing it would refuse the operand the whole
 * construct is built from.
 *
 * What stays refused is a base further along a chain -- `a` in `a.b?.c`, where
 * `a.b` is part of the chain but carries no `?.` of its own. Such a link
 * short-circuits on a receiver that is not its own, and nothing here threads the
 * chain's root to it.
 */
const isOptionalChainBase = (node: ts.Expression): boolean => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) {
    return parent.expression === node && ts.isOptionalChain(parent) && parent.questionDotToken === undefined
  }
  return false
}

type ReferenceClassification =
  | { readonly kind: 'skip' }
  | { readonly kind: 'blocked'; readonly reason: string; readonly missingPrimitive: PrimitiveFamily | null }
  | { readonly kind: 'reference'; readonly form: ReferenceOperation['form'] }

const classifyIdentifier = (node: ts.Identifier): ReferenceClassification => {
  if (isDeclarationNamePosition(node)) return { kind: 'skip' }
  if (isPropertyAssignmentKeyPosition(node)) return { kind: 'skip' }
  if (isNonReferenceSpecifierPosition(node)) return { kind: 'skip' }
  if (isLabelPosition(node)) return { kind: 'skip' }
  if (ts.isPartOfTypeNode(node)) return { kind: 'skip' }

  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (parent.expression.kind === ts.SyntaxKind.SuperKeyword) {
      return { kind: 'blocked', reason: 'super property references require home-object resolution semantics', missingPrimitive: 'P1' }
    }
    // An ordinary IdentifierName is never looked up in an environment: the
    // whole property access already owns this as its static key.
    return { kind: 'skip' }
  }
  if (isOptionalChainBase(node)) {
    return { kind: 'blocked', reason: 'optional chaining requires short-circuit selection semantics', missingPrimitive: 'P0' }
  }
  return { kind: 'reference', form: 'identifier' }
}

const classifyPrivateIdentifier = (node: ts.PrivateIdentifier): ReferenceClassification => {
  // `class C { #x }`'s `#x` declares the private name; only access sites
  // (`o.#x`, `#x in o`) resolve it against the enclosing class's private scope.
  if (isDeclarationNamePosition(node)) return { kind: 'skip' }
  // `o.#x`'s name half never arrives here at all -- `census.ts`'s
  // `isValueReference` excludes a property access's own name, and
  // `properties.ts` resolves it as the constant key it is. The grammar admits
  // a private name in exactly one other position, so this is `#x in o` and
  // nothing else: the brand check, whose entire question is whether a receiver
  // the checker did NOT prove is an instance carries the private element.
  // Answering it needs a runtime brand a fixed struct layout does not have --
  // every instance of a class has every one of its members, so "does this
  // object have `#x`" is not a question the layout can be asked. Refused by
  // name rather than answered with a constant `true`, which would be right for
  // every receiver the checker proves and wrong for the ones the operator
  // exists to distinguish.
  return {
    kind: 'blocked',
    reason: 'a `#x in o` brand check needs a runtime private-element table no fixed layout carries',
    missingPrimitive: 'P1'
  }
}

/** Whether this name is the target of a plain `=`, which writes without reading. */
const isPlainAssignmentTarget = (node: ts.Node): boolean => {
  const parent = node.parent
  return ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

/**
 * Whether `node` sits directly in a `typeof` expression's operand position,
 * over any purely syntactic `(...)` wrapper (`dead-typeof-guards.ts`'s
 * `unwrapParens` strips the identical wrapper for the whole guard; this
 * strips it for the operand alone).
 *
 * ECMA-262 13.5.1.2 `typeof`: it evaluates its operand to a Reference Record
 * and only THEN asks `IsUnresolvableReference` -- and if that is true,
 * returns `"undefined"` directly, WITHOUT ever calling `GetValue`. That is a
 * carve-out `typeof` alone has: `x` with no cell anywhere still throws for
 * every other reader (an ordinary read, an argument, a callee), because
 * `GetValue` really does throw for them -- `typeof x` is the one shape the
 * spec defines a non-throwing answer for. `censusUnresolvableNames`'s own doc
 * comment is written about exactly this idiom (`typeof Float16Array !==
 * 'undefined'`, three.js), which is what makes skipping this carve-out a
 * silent miscompile rather than a missed optimization: `typeof Deno !==
 * 'undefined'` would abort where the language returns `false`.
 */
const isTypeofOperand = (node: ts.Node): boolean => {
  let current: ts.Node = node
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent
  return ts.isTypeOfExpression(current.parent) && current.parent.expression === current
}

/**
 * Whether `const alias = subject` names a callable whose type is settled PER
 * CALL rather than once at the declaration.
 *
 * A bare identifier never CHOOSES between callable values -- it names exactly
 * one declaration, the "alias hop" shape `genericSubjectOf` (identities.ts)
 * and `bindingHoldsExactly` (invocations.ts) both key on. For a GENERIC
 * subject, reading that declaration's own type asks the checker for `box`'s
 * unspecialized declared type independent of any call, which is what
 * `calleeAwareTypeAt` exists to avoid: it closes every read of the alias to
 * the same (wrong) type regardless of which instantiation the call names, and
 * `certify` then refused the alias's own binding for publishing a per-copy
 * type nothing could convert into the un-narrowed one.
 *
 * The generic test is the whole condition, and it is not a heuristic. An
 * OVERLOAD SET is the other thing a bare identifier can alias, and it wants
 * the opposite answer: `const asValue = decorate` over `decorate(text)` /
 * `decorate(text, suffix)` is ONE runtime function with ONE calling
 * convention, joined by `sharedAbiOf` (representation/derive.ts) across every
 * arm. Narrowing it per call publishes whichever arm that call selected --
 * `(string) -> string` at `asValue('c')` -- and nothing converts the
 * implementation's joined `(string, optional(string)) -> string` into it, so
 * the program refused entirely. Per-call narrowing is right where the call
 * MAKES the type and wrong where it merely picks an arm of one that already
 * exists.
 */
const aliasIsInstantiatedPerCall = (checker: ts.TypeChecker, initializer: ts.Expression): boolean =>
  ts.isIdentifier(initializer) &&
  checker
    .getTypeAtLocation(initializer)
    .getCallSignatures()
    .some((signature) => (signature.typeParameters?.length ?? 0) > 0)

const buildReference = (
  candidate: CensusCandidate,
  node: ts.Identifier | ts.PrivateIdentifier | ts.PropertyAccessExpression,
  form: ReferenceOperation['form'],
  context: ProducerContext
): CandidateContribution => {
  const id = mintOperationId(context.ordinals, candidate.id, 'reference')
  // An identifier resolved and read only to be invoked immediately reads
  // through the same narrowing an invocation's own callee operand already
  // gets (`calleeAwareTypeAt`, shared.ts): the checker resolved this call to
  // exactly one signature, and that is a stronger, narrower fact than "the
  // name's general declared type", which for an overloaded ambient global
  // (`setTimeout`, `fetch`, `clearTimeout` -- two incompatible DOM/lib
  // overloads) has no single physical calling convention at all. Deriving the
  // reference/binding-read pair from the general type asked a question the
  // overload set was never going to answer, even though the invocation right
  // next to it already asked -- and answered -- the narrower one. A
  // non-callee identifier is untouched: `calleeAwareTypeAt` falls back to the
  // plain type the moment `enclosingCallIfCallee` says this name is not a
  // callee.
  //
  // `new` is deliberately excluded from this narrowing. `calleeAwareTypeAt`'s
  // narrowed answer (`resolvedSignatureTypeOf`, structural.ts) is always a
  // bare `{kind:'signature', construct:[...]}` -- it names no declared anchor,
  // by construction, because the checker's resolved signature carries no
  // reference back to the class it came from. For an ordinary function that
  // costs nothing: a function's identity for conversion purposes is its ABI,
  // full stop. For a class named directly in `new MyClass(...)`, it is a
  // regression: the *general* type already carries the class's own
  // `class-constructor` anchor -- richer than any one resolved signature,
  // needed for `constructor-family`/class-ref conversions elsewhere in the
  // same program -- and overload widening across a class's own constructors
  // is `deriveClassConstructor`'s job (via `sharedAbiOf`'s widening), not a
  // per-call-site narrowing here. Applying the narrowing there mints a second,
  // anchor-less carrier for the identical class, and nothing converts between
  // the two: exactly the `constructor-family -> constructor-value-dispatch`
  // split this comment used to introduce before it was scoped to non-`new`.
  // A namespace-qualified member (`Debug.assert`) resolves to its member's
  // symbol the way a bare `assert` inside the namespace body does -- one
  // rule, `namespace-paths.ts`, shared with the census that gave this node
  // the `reference` family in the first place.
  const symbol = ts.isPropertyAccessExpression(node)
    ? (context.namespacePaths.memberSymbolOf(node) ?? undefined)
    : valueSymbolAt(context.checker, node)
  const call = ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? enclosingCallIfCallee(node) : null
  const variable = symbol?.valueDeclaration
  const declarationNode = symbol ? context.identities.valueDeclarationOfSymbol(symbol) : null
  const constInitializer =
    call &&
    !ts.isNewExpression(call) &&
    variable &&
    ts.isVariableDeclaration(variable) &&
    variable.type === undefined &&
    ts.getJSDocType(variable) === undefined &&
    variable.initializer !== undefined &&
    !ts.isArrowFunction(variable.initializer) &&
    !ts.isFunctionExpression(variable.initializer) &&
    !aliasIsInstantiatedPerCall(context.checker, variable.initializer) &&
    ts.isVariableDeclarationList(variable.parent) &&
    (variable.parent.flags & ts.NodeFlags.Const) !== 0
      ? variable.initializer
      : null
  // A const with no TypeScript or JSDoc annotation physically keeps exactly its initializer when
  // that initializer CHOOSES between callable values. A function expression
  // or arrow is itself the one callable allocation, and asking for the
  // initializer's contextual type at a direct call can expose its annotated
  // RESULT (`(): Iterable<T> => ...`) instead of its callable type. Keep those
  // on the binding's ordinary callee-aware path; there is no union arm to
  // recover from them in the first place.
  // When the checker gives a union of functions a common callable view at a
  // direct call, that view is not a conversion the runtime performs: the cell
  // still holds one original arm and [[Call]] dispatches through it. Publish
  // the initializer's structural type here so the existing tagged-union call
  // lowering sees the carrier the binding actually holds.
  const type =
    (ts.isIdentifier(node) ? destinationPreservesDeclaredAbsence(context, node, declarationNode) : null) ??
    (constInitializer
      ? context.types.typeAt(constInitializer)
      : call && !ts.isNewExpression(call)
        ? calleeAwareTypeAt(context, node)
        : context.types.typeAt(node))
  if (ts.isIdentifier(node) && context.unresolvableNames.isIntrinsicGlobalThis(node)) {
    // `globalThis` is a language-owned singleton, but the checker represents
    // it as a synthetic symbol with no declaration. Its physical surface is
    // necessarily open: hosts and programs may install arbitrary global
    // properties. Carry the object itself as one native dictionary and only
    // box its values, whose source type is genuinely `unknown`.
    const unknown = context.table.intern({ kind: 'primitive', primitive: 'unknown' })
    const globalType = context.table.intern({
      kind: 'object',
      members: [],
      index: [{ key: 'string', value: unknown, readonly: false }],
      membersDropped: false
    })
    const operation: ReferenceOperation = {
      id,
      family: 'reference',
      form: 'global-this',
      strict: ts.isExternalModule(node.getSourceFile()),
      unresolvableThrows: false,
      hasNoCell: false,
      caller: candidate.caller,
      operands: [],
      results: [mintResult(id, 'value', globalType)],
      completion: normalCompletion,
      effects: { ...pureEffects, readsMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    return { kind: 'operations', operations: [operation], edges: [] }
  }
  // Every citation of the name `undefined` is the language constant
  // (`literalConstantOf`). A declaration of that name would make some
  // citations a real binding read and leave the two disagreeing, silently, on
  // whichever side the reader happened to take -- so it is refused here rather
  // than answered twice.
  if (ts.isIdentifier(node) && node.text === 'undefined' && (symbol?.declarations?.length ?? 0) > 0) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        'a declaration named `undefined` shadows the language constant, which is not modelled',
        'P1'
      )
    }
  }
  // `hasNoCell` is the NAME fact (no symbol anywhere); `unresolvableThrows` is
  // the BEHAVIOR that usually follows from it, except for `typeof`
  // (`isTypeofOperand`'s own comment states the carve-out: ECMA-262 13.5.1.2
  // returns `"undefined"` for exactly this shape without ever calling
  // `GetValue`). Kept apart, per `ReferenceOperation.hasNoCell`'s own comment,
  // because a `value` result still has to be published either way -- there is
  // no cell a `binding` read could ever be minted against -- and only the
  // COMPLETION (throw, or the constant `typeof` returns) differs.
  const hasNoCell = symbol === undefined
  const unresolvableThrows = hasNoCell && !isTypeofOperand(node)
  const operation: ReferenceOperation = {
    id,
    family: 'reference',
    form,
    strict: ts.isExternalModule(node.getSourceFile()),
    unresolvableThrows,
    hasNoCell,
    caller: candidate.caller,
    operands: [],
    // A name with no cell publishes its value HERE, at the coordinate
    // `unresolvableValueResultAt` states, because the `binding` read below is
    // never minted for it -- there is no declaration to read through. The
    // `reference` result is kept alongside so an assignment consumer, which
    // cites the Reference rather than a value, is unaffected.
    results:
      hasNoCell && ts.isIdentifier(node)
        ? [mintResult(id, 'reference', type), mintResult(id, 'value', type)]
        : [mintResult(id, 'reference', type)],
    completion: unresolvableThrows ? throwingCompletion : normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  // Resolving a name produces a Reference Record, not a value: GetValue is a
  // separate step, and it is the step every consumer of the name actually
  // needs. Publishing only the reference leaves a graph in which nothing ever
  // reads a binding, and each consumer would have to invent the read itself --
  // which is how one program ends up with several disagreeing answers to
  // "what does this name hold".
  // The *value* declaration, not the anchor: a name in value position reads
  // whatever holds the value, and for a merged ambient global (`interface
  // Error` + `declare var Error`) that is the second declaration, not the
  // first. `frontend.ts`'s `bindAmbientValue` keys the host placement this
  // read has to find by the same rule, so the two agree by construction.
  const declaration = symbol ? context.identities.symbolValueDeclarationId(symbol, node) : null
  if (
    declaration !== null &&
    (context.hostSingletonBindings.has(declaration) || context.hostNamespaceBindings.has(declaration)) &&
    (context.globalHostMutationTaint.has('*') || context.globalHostMutationTaint.has(declaration))
  ) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        'an authenticated host global may be mutated through globalThis, so its bare native binding identity is not stable',
        'P0'
      )
    }
  }
  // The program's own script-level `var` is an own property of the global
  // object (9.1.1.4.17), so `Object.defineProperty(globalThis, 'X', …)` writes
  // the same cell this bare read names. The mutation census files that write
  // against the declaration; a read that ignored it would answer with the
  // value the redefinition replaced -- the stale-binding miscompile, not a
  // refusal. `properties.ts` refuses the `globalThis.X` spelling by the same
  // rule; a `'*'` taint says the census could not place the write at all.
  if (
    declaration !== null &&
    symbol?.valueDeclaration !== undefined &&
    isScriptGlobalObjectPropertyDeclaration(symbol.valueDeclaration) &&
    (context.globalHostMutationTaint.has('*') || context.globalHostMutationTaint.has(declaration))
  ) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        "a script's global var is redefined through the global object (Object.defineProperty(globalThis, ...)), so its bare read has two writers this backend does not reconcile",
        'P0'
      )
    }
  }
  // A plain `=` target is resolved and written, never read: PutValue takes the
  // Reference, not a value. Reading it anyway would invent an access the
  // program does not perform -- and for a `const` or a `let` before its
  // initializer, that invented read is a temporal-dead-zone throw the source
  // never had. A compound target is excluded because it genuinely does read.
  if (!declaration || isPlainAssignmentTarget(node)) return { kind: 'operations', operations: [operation], edges: [] }

  const { mutable, temporalDeadZone } = declarationNode ? bindingKindOf(declarationNode) : { mutable: true, temporalDeadZone: false }
  const readId = mintOperationId(context.ordinals, candidate.id, 'binding')
  const read: BindingOperation = {
    id: readId,
    family: 'binding',
    action: 'read',
    declaration,
    mutable,
    temporalDeadZone,
    ...(context.commonJsBindings.has(declaration)
      ? {
          commonJs: {
            global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
            owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body'),
            ...(context.commonJsModuleRecords.moduleExportExpressionAt(node) ? { nativeRecord: true as const } : {})
          }
        }
      : {}),
    caller: candidate.caller,
    operands: [operand('reference', 0, { kind: 'result', result: semanticResultId(id, 'reference') }, type, { kind: 'provenance' })],
    results: [mintResult(readId, 'value', type)],
    // A read of a dead-zone binding throws; one of an initialized cell cannot.
    completion: temporalDeadZone ? throwingCompletion : normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return {
    kind: 'operations',
    operations: [operation, read],
    edges: [
      { kind: 'value', result: semanticResultId(id, 'reference'), to: readId, role: 'reference', ordinal: 0 },
      ...hoistedInitializerEdges(context.identities, declarationNode, node, readId)
    ]
  }
}

/**
 * The precedence a HOISTED function declaration's own binding needs when a
 * read of its name appears above it.
 *
 * `FunctionDeclarationInstantiation` initializes a function declaration's
 * binding before the first statement of the enclosing body runs, so a call
 * written above the declaration reaches a cell that already holds the
 * function. Nothing in the graph says that on its own: a binding read cites
 * the *reference*, never the write (the same gap `orderOwnerOperations`'s
 * catch-clause prologue needed an explicit edge for), and the census's
 * source-order ordinal then schedules the initialize AFTER the read. hono's
 * `compose` is the shape -- `return dispatch(0)` above `async function
 * dispatch(i)`, both closing over the same `let index` -- and it emitted a
 * call on a cell no operation had written, which clang caught as "use of
 * undeclared identifier".
 *
 * Only for a read that PRECEDES the declaration, and this is what keeps the
 * edge from over-stating the hoist. Source order already orders a read below
 * it. And the function's own body -- where a recursive read lives -- is inside
 * the declaration, so it is excluded by the same test: claiming the enclosing
 * body's prologue runs before a nested body's statements would be false, and a
 * read in a body the declaration encloses is ordered by the call that reaches
 * it, not by this.
 *
 * A `let`/`const` gets no such edge, deliberately: its binding is NOT
 * initialized early, and a read above it is a temporal-dead-zone throw whose
 * order the source already states.
 */
const hoistedInitializerEdges = (
  identities: IdentityTable,
  declarationNode: ts.Declaration | null,
  read: ts.Node,
  readId: OperationId
): readonly SemanticEdge[] => {
  if (!declarationNode || !ts.isFunctionDeclaration(declarationNode)) return []
  if (declarationNode.pos <= read.pos) return []
  return [{ kind: 'evaluation', from: operationId(identities.nodeIdOf(declarationNode), 'binding', 0), to: readId }]
}

/**
 * Whether a `this` here can throw before producing a value.
 *
 * A derived constructor's `this` is uninitialized until `super()` returns, and
 * reading it before that is a ReferenceError. Everywhere else the binding is
 * established before the body runs and the read cannot fail. The walk stops at
 * the first non-arrow function because an arrow has no this-binding of its own:
 * `GetThisEnvironment` skips it, which is the same reason the receiver an arrow
 * reads belongs to its enclosing method.
 */
const thisCanThrow = (node: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isConstructorDeclaration(current)) {
      const classNode = current.parent
      if (!ts.isClassLike(classNode)) return false
      return (classNode.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    }
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current)) return false
  }
  return false
}

/**
 * Whether the nearest scope a `this` here would be normalized under is an
 * arrow.
 *
 * Mirrors the walk `callerOf` (census.ts) performs to decide which owner an
 * operation belongs to, stopping at the same boundaries -- reusing the same
 * stopping set here, rather than inventing a second one, is what keeps this
 * answer from silently drifting away from the owner census actually assigns.
 * An arrow owner has no this-binding of its own to declare in its calling
 * convention (`GetThisEnvironment` skips it), so a `this` whose nearest owner
 * is an arrow is not reading that owner's own frame -- it is reading whatever
 * the lexically enclosing scope bound, which crosses a physical-body boundary.
 */
const nearestOwningScopeIsArrow = (node: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) return true
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current)
    ) {
      return false
    }
  }
  return false
}

/** The class whose constructor object a static `this` denotes, plus whether the nearest owner is a non-callable static block. */
const staticThisOwner = (node: ts.Node): { readonly classNode: ts.ClassLikeDeclaration; readonly block: boolean } | null => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isClassStaticBlockDeclaration(current)) {
      return ts.isClassLike(current.parent) ? { classNode: current.parent, block: true } : null
    }
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isPropertyDeclaration(current)
    ) {
      const isStatic = (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Static) !== 0
      return isStatic && ts.isClassLike(current.parent) ? { classNode: current.parent, block: false } : null
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return null
  }
  return null
}

/**
 * Whether this `this` is genuinely bound to an enclosing class, as opposed to
 * the global object, `undefined`, or some other binding this layer does not
 * model.
 *
 * The checker already resolves `ResolveThisBinding` for us -- `this` inside a
 * class member (through any number of nested arrows) resolves to the class
 * declaration's own symbol, the same symbol regardless of how many arrow
 * frames sit between the keyword and the member. Reusing that answer, rather
 * than re-deriving "does this method have a receiver" a second way here, is
 * what keeps this check from becoming a second authority that can disagree
 * with `structural.ts`'s over the same question.
 */
const isClassBoundThis = (node: ts.Node, context: ProducerContext): boolean => {
  const symbol = context.checker.getSymbolAtLocation(node)
  return (symbol?.declarations ?? []).some((declaration) => ts.isClassLike(declaration) || ts.isObjectLiteralExpression(declaration))
}

/**
 * `this`: one operation that resolves the binding and publishes its value.
 *
 * Every other reference form is two operations -- resolve, then `GetValue` --
 * because a Reference Record is a real intermediate a consumer can assign
 * through. `this` has no such intermediate, so splitting it would mint a read
 * of a Reference that the language never creates.
 */
const buildThisReference = (candidate: CensusCandidate, node: ts.Node, context: ProducerContext): CandidateContribution => {
  // An arrow closes over `this` rather than binding one: physically, reading
  // it means capturing the enclosing method's receiver across a function-
  // object boundary. That capture is installed (`targets/cpp/captures.ts`
  // computes the environment; `ir/lower-operands.ts`'s `resolveRequiredOperand`
  // lowers the read), gated on this operand's own *role* rather than on a new
  // `OperandSource` variant -- `role` is an ordinary string
  // (`semantics/model/operands.ts`), and `captured-receiver` is this
  // producer's own proof, computed once, right here, that `isClassBoundThis`
  // already confirmed the read resolves to an enclosing class's own instance
  // -- not to `undefined`, the global object, or some other binding this
  // layer does not model. Every other `this` -- inside a method or
  // constructor's own body, or inside a plain function with no lexically
  // enclosing class receiver at all -- keeps the ordinary `receiver` role, so
  // a genuinely undeclared read still refuses exactly as it always has
  // (`ir/lower-operands.ts`'s `resolveRequiredOperand`, unchanged for that
  // role). Nothing downstream can mistake one for the other: the role a
  // *plain* function's dynamic `this` might coincidentally share a carrier
  // with is never `captured-receiver`, because only this one condition ever
  // mints that role.
  const captured = nearestOwningScopeIsArrow(node) && isClassBoundThis(node, context)
  const staticOwner = staticThisOwner(node)
  const id = mintOperationId(context.ordinals, candidate.id, 'reference')
  const type = staticOwner ? context.types.valueTypeAt(staticOwner.classNode) : context.types.typeAt(node)
  const canThrow = thisCanThrow(node)
  const operation: ReferenceOperation = {
    id,
    family: 'reference',
    form: 'this',
    strict: ts.isExternalModule(node.getSourceFile()),
    unresolvableThrows: canThrow,
    hasNoCell: false,
    caller: candidate.caller,
    // The receiver is supplied by the frame the caller established, so it is
    // recorded as provenance rather than as a runtime step: nothing here
    // evaluates it, and an operand that claimed to would order an evaluation
    // the language does not perform.
    operands: [
      operand(staticOwner?.block ? 'static-class-receiver' : captured ? 'captured-receiver' : 'receiver', 0, { kind: 'receiver' }, type, {
        kind: 'provenance'
      })
    ],
    results: [mintResult(id, 'value', type)],
    completion: canThrow ? throwingCompletion : normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

/**
 * `super` (in `super.x`/`super.x(...)`): one operation, the same shape
 * `this` gets and for the same reason -- `MakeSuperPropertyReference` calls
 * `GetThisEnvironment().GetThisBinding()` to build the reference's `thisValue`
 * component, so evaluating a super reference publishes a value directly and
 * can throw before it does, exactly as `this` can.
 *
 * The one place this genuinely differs from `buildThisReference` is `type`:
 * a `this` read publishes the checker's type AT the keyword, which for `this`
 * is the enclosing class's own instance type, but the checker types a `super`
 * keyword as the class's *base* -- `[[HomeObject]]`'s prototype, exactly the
 * fact `GetSuperBase` reads -- without this compiler asking it to resolve
 * anything: `class Derived extends Base { m() { super.x } }` types the
 * `super` in `super.x` as `Base`, verified directly against the checker
 * rather than assumed. Publishing THAT type as this operation's result is
 * what makes a member reached off it -- `classMemberText`,
 * emit-properties.ts -- start its lookup one class above `this`'s own,
 * which is the whole of what a home object resolution has to decide here:
 * which class a member name resolves against is a fully static fact for a
 * class method, so no runtime `[[HomeObject]]` slot is needed to decide it.
 * The VALUE, in every other respect, is `this`'s own value unchanged --
 * `super.x` reads a member starting one prototype above `this`'s class and
 * calls it (when called) WITH `this` as receiver, never with a `Base`-typed
 * value substituted in -- so the operand below is the identical
 * `receiver`/`captured-receiver` provenance `buildThisReference` reads,
 * differing only in which type is published alongside it. An implicit
 * `Derived` argument reaching a callable frame typed for `Base`'s own
 * receiver is an ordinary base-class upcast, which the emitted C++
 * inheritance (`records.ts`) already allows without help from this operation.
 */
/**
 * An `arguments` reference site: the value, published where the citer looks.
 *
 * `argumentsObjectValueAt` (`bindings.ts`) already builds this value -- it is
 * what `587286fc1` added so a `...arguments` spread had an operand to cite --
 * and this is the same construction reached from an ordinary reference
 * instead of from a spread. Reusing it is not a convenience: the phantom rest
 * parameter's `reference`/`parameter-value` operation is ALSO what
 * `projection/abi.ts`'s `parameterCarrierKeys` counts as evidence that the
 * body physically binds that slot, so a body reading `arguments` stops
 * blocking with "binds 1 physical parameter(s) but the ABI declares 2" by
 * publishing the value it was already missing -- one operation answering both.
 *
 * Returned BEFORE `buildReference`'s own mint, never after: that function
 * opens by taking `reference` ordinal 0 at this node for the Reference Record,
 * and the phantom parameter read has to be the one holding it.
 */
/**
 * Whether this `arguments` site is WRITTEN THROUGH rather than read.
 *
 * Every reference site mints its own copy of the `arguments` object -- see
 * `argumentsObjectValueAt`'s own note that this is "correct only because
 * `arguments` is exclusively READ". A write breaks exactly that premise:
 * `arguments[0] = 5; return arguments[0]` would store into one fresh array
 * and read from a second, answering the original argument and never the
 * stored value. Nothing downstream can see that -- the program compiles, the
 * certificate is clean, and the answer is quietly wrong -- so the site is
 * refused here instead.
 *
 * It is only the write THROUGH the object that is refused, never a read: an
 * `arguments[i]` on the right of an assignment, or anywhere else, is one of
 * the reads this whole path exists to publish.
 *
 * `arguments = x` itself needs no case: it is an early SyntaxError in strict
 * mode, and every ES module is strict.
 */
const isWrittenThroughArguments = (node: ts.Identifier): boolean => {
  const access = node.parent
  if (!ts.isElementAccessExpression(access) && !ts.isPropertyAccessExpression(access)) return false
  if (access.expression !== node) return false
  const parent = access.parent
  if (ts.isBinaryExpression(parent) && parent.left === access) return isAssignmentOperatorKind(parent.operatorToken.kind)
  if (ts.isPostfixUnaryExpression(parent)) return true
  if (ts.isPrefixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken
  }
  return ts.isDeleteExpression(parent)
}

const buildArgumentsObjectReference = (
  candidate: CensusCandidate,
  node: ts.Identifier,
  phantomOrdinal: number,
  context: ProducerContext
): CandidateContribution => {
  if (isWrittenThroughArguments(node)) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        'a write through the `arguments` object; every reference site publishes its own copy, so the store would be invisible to every later read',
        'P1'
      )
    }
  }
  const built = argumentsObjectValueAt(node, candidate.id, candidate.caller, candidate.evaluationOrdinal, context)
  // The census said this site has a phantom at `phantomOrdinal`; the builder
  // re-derives the same fact and would answer `null` if it disagreed. Neither
  // outcome is guessed at.
  if (!built) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        'the `arguments` census recognized a phantom rest parameter at this site and the value builder did not',
        'P1'
      )
    }
  }
  // The publication and the citation are two authorities over one identity,
  // and a disagreement between them is invisible -- a withheld operation, no
  // error. So the publisher checks the citer's own rule against what it
  // actually minted, and refuses out loud instead.
  const predicted = argumentsObjectResultAt(candidate.id, phantomOrdinal)
  if (built.value !== predicted) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'reference',
        `an \`arguments\` site publishes its value as ${built.value}, and \`citeExpressionResult\` cites ${predicted}`,
        'P1'
      )
    }
  }
  return { kind: 'operations', operations: built.operations, edges: built.edges }
}

const buildSuperReference = (candidate: CensusCandidate, node: ts.Node, context: ProducerContext): CandidateContribution => {
  const captured = nearestOwningScopeIsArrow(node) && isClassBoundThis(node, context)
  const id = mintOperationId(context.ordinals, candidate.id, 'reference')
  const type = context.types.typeAt(node)
  const canThrow = thisCanThrow(node)
  const operation: ReferenceOperation = {
    id,
    family: 'reference',
    form: 'super-property',
    strict: ts.isExternalModule(node.getSourceFile()),
    unresolvableThrows: canThrow,
    hasNoCell: false,
    caller: candidate.caller,
    operands: [operand(captured ? 'captured-receiver' : 'receiver', 0, { kind: 'receiver' }, type, { kind: 'provenance' })],
    results: [mintResult(id, 'value', type)],
    completion: canThrow ? throwingCompletion : normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

export const createReferenceProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'reference',
  contribute: (candidate) => {
    const node = candidate.node
    if (node.kind === ts.SyntaxKind.ThisKeyword) return buildThisReference(candidate, node, context)
    if (node.kind === ts.SyntaxKind.SuperKeyword) return buildSuperReference(candidate, node, context)
    if (ts.isIdentifier(node)) {
      // Ahead of `classifyIdentifier`, which reads only syntax and would call
      // this an ordinary name resolution -- the one thing `arguments` is not.
      const phantomOrdinal = context.argumentsObjects.phantomOrdinalOf(node)
      if (phantomOrdinal !== null) return buildArgumentsObjectReference(candidate, node, phantomOrdinal, context)
      const classification = classifyIdentifier(node)
      if (classification.kind === 'skip') return { kind: 'operations', operations: [], edges: [] }
      if (classification.kind === 'blocked') {
        return { kind: 'blocked', blocker: blocked(candidate.id, 'reference', classification.reason, classification.missingPrimitive) }
      }
      return buildReference(candidate, node, classification.form, context)
    }
    if (ts.isPropertyAccessExpression(node)) {
      // The census routes a property access here only when it is a
      // namespace-qualified member (`familyOf`, census.ts); anything else
      // reaching this producer is the two having drifted apart.
      if (context.namespacePaths.memberSymbolOf(node) === null) {
        throw new Error('reference producer received a property access that is not a namespace-qualified member')
      }
      // `identifier`, deliberately: the operation IS a name resolution to a
      // declared cell, which is the whole of what that form states downstream.
      return buildReference(candidate, node, 'identifier', context)
    }
    if (ts.isPrivateIdentifier(node)) {
      const classification = classifyPrivateIdentifier(node)
      if (classification.kind === 'skip') return { kind: 'operations', operations: [], edges: [] }
      if (classification.kind === 'blocked') {
        return { kind: 'blocked', blocker: blocked(candidate.id, 'reference', classification.reason, classification.missingPrimitive) }
      }
      return buildReference(candidate, node, classification.form, context)
    }
    // census.ts assigns the 'reference' family only to Identifier,
    // PrivateIdentifier, and `this` nodes; reaching this means the census and
    // this producer have drifted out of sync with each other.
    throw new Error(`reference producer received a candidate of unexpected syntax kind ${ts.SyntaxKind[node.kind]}`)
  }
})
