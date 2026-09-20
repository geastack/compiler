import { isObjectTagCalleePart } from './object-tag.js'
import ts from 'typescript'
import { operationId, semanticResultId, type DeclarationId, type StructuralTypeId } from '../../../identity/ids.js'
import type { PrimitiveFamily } from '../../model/coverage.js'
import type { SemanticEdge } from '../../model/edges.js'
import {
  normalCompletion,
  pureEffects,
  throwingCompletion,
  type EffectBehavior,
  type OperandEvaluation,
  type OperandSource
} from '../../model/operands.js'
import type { PropertyOperation } from '../../model/operations.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { CensusCandidate } from '../census.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { optionalChainGuardOf, publishesShortCircuit } from './optional-chain.js'
import { excludesNullish } from './nullish.js'
import { calleeAwareTypeAt, isStrictContext, logicalAssignmentOperators, sourceForValue, symbolMemberKeyOf } from './shared.js'
import type { ProducerContext } from '../producer-context.js'
import { citeExpressionResult } from './references.js'
import { isGlobalFunctionConstructor, literalMemberNameOf } from '../derived-expression-type.js'
import { enclosingCallIfCallee, outermostErasureOf, unwrapErasedExpression } from './erasure.js'
import { isScriptGlobalObjectPropertyDeclaration } from '../script-global-redefinition.js'
import { primitivePropertyIsAbsent } from '../primitive-property-absence.js'
import { assertedReceiverArmMayLackMember } from '../asserted-arm-absence.js'

type AccessNode = ts.PropertyAccessExpression | ts.ElementAccessExpression

/** Whichever internal method (or pair of methods) a property access's syntactic position calls for. */
type PropertyIntent =
  | { readonly kind: 'get' }
  | { readonly kind: 'set' }
  | { readonly kind: 'delete' }
  /** Compound assignment and `++`/`--` read the old value before writing the new one. */
  | { readonly kind: 'get-then-set' }
  /**
   * `o.p ??= v` -- ECMA-262 13.15.2. The `[[Get]]` runs unconditionally and is
   * the guard; the `[[Set]]` runs only on the branch the operator does not
   * short-circuit on, and stores the RIGHT-HAND side rather than the merge.
   */
  | { readonly kind: 'logical-set'; readonly takenWhen: 'truthy' | 'falsy' | 'nullish' }

const compoundAssignmentOperators: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken
])

/**
 * `&&=`/`||=`/`??=` only write when the guard takes a particular branch, which
 * is the same short-circuit primitive optional chaining needs and that is not
 * installed yet. Modelling them as an unconditional get-then-set would write a
 * value the source program would have left untouched -- a silent miscompile,
 * not a simplification -- so they are blocked instead.
 */
const intentOf = (node: AccessNode): PropertyIntent => {
  // The position this access occupies is read past the wrappers that erase:
  // `o.p! = 1` and `(o.p) = 1` are the same store `o.p = 1` is, and reading
  // the raw `parent` saw the `!` and published no store at all.
  const placed = outermostErasureOf(node)
  const parent = placed.parent
  if (ts.isDeleteExpression(parent) && parent.expression === placed) return { kind: 'delete' }
  // `k in o.p` is deliberately NOT a `[[HasProperty]]` on `o`. ECMA-262 13.10.1
  // evaluates the right operand with GetValue -- an ordinary `[[Get]]` of `p`
  // -- and performs `HasProperty` on the RESULT, keyed by the LEFT operand. An
  // access classified here by its position under `in` would ask the wrong
  // question of the wrong object: `'value' in table.a` became `table.has("a")`,
  // which is a different key on a different receiver, and the boolean it
  // published then poisoned the operator's own object operand. The operator
  // owns its `[[HasProperty]]`; `ir/lower.ts` lowers it to the shared
  // primitive, and this family only ever reads.
  if (ts.isBinaryExpression(parent) && parent.left === placed) {
    const operator = parent.operatorToken.kind
    if (operator === ts.SyntaxKind.EqualsToken) return { kind: 'set' }
    if (logicalAssignmentOperators.has(operator)) {
      return {
        kind: 'logical-set',
        takenWhen:
          operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
            ? 'truthy'
            : operator === ts.SyntaxKind.BarBarEqualsToken
              ? 'falsy'
              : 'nullish'
      }
    }
    if (compoundAssignmentOperators.has(operator)) return { kind: 'get-then-set' }
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === placed &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return { kind: 'get-then-set' }
  }
  return { kind: 'get' }
}

type KeyResolution =
  | { readonly kind: 'key'; readonly computed: boolean; readonly source: OperandSource; readonly type: StructuralTypeId }
  | { readonly kind: 'blocked'; readonly reason: string; readonly missingPrimitive: PrimitiveFamily | null }

const keyOf = (node: AccessNode, context: ProducerContext): KeyResolution => {
  // A static key is a String, whatever the property it names holds. Asking the
  // checker for the type at the name node answers a different question -- it
  // gives the *property's* type -- and taking that answer spells the key with
  // the value's carrier, so `origin.y` looks up a `double` named `y`.
  const staticKeyType = context.table.intern({ kind: 'primitive', primitive: 'string' })

  if (ts.isPropertyAccessExpression(node)) {
    // A private name is a static key exactly as a written one is, and needs no
    // brand check *here*. ECMA-262 13.3.2.1 does perform one --
    // `PrivateElementFind` throws a `TypeError` when the receiver carries no
    // matching PrivateElement -- but the checker has already proven this
    // receiver does: a private name is in scope only inside the class that
    // declares it, and the checker refuses `o.#x` for any `o` whose type is not
    // that class. So the only receiver this syntax can ever reach is one whose
    // layout has the member, and the find cannot fail.
    //
    // What genuinely needs the brand check is `#x in o`, whose whole purpose is
    // asking about a receiver that might not be an instance; that reaches the
    // reference producer, not this one, and is refused by name there.
    //
    // `node.name.text` carries the `#` for a private name, which is precisely
    // the spelling the checker reports for the member -- so this read and
    // `class-lifecycle.ts`'s definition name one member without either side
    // inventing a mangling.
    return { kind: 'key', computed: false, source: { kind: 'constant', text: node.name.text, literal: 'string' }, type: staticKeyType }
  }
  const argument = node.argumentExpression
  if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
    // ToPropertyKey turns a numeric index into a String too: `o[0]` and `o["0"]`
    // reach the same property, and giving one a numeric carrier would make two
    // spellings of one key look like two different keys.
    return { kind: 'key', computed: false, source: { kind: 'constant', text: argument.text, literal: 'string' }, type: staticKeyType }
  }
  const argumentType = context.types.typeAt(argument)
  // A `unique symbol` key that names a DECLARED member is compile-time-known:
  // `class C { [S]: T }` declares a member and `this[S]` reads it, exactly as
  // `this.x` reads `x`. Carrying it as a constant is what makes a symbol-named
  // field an ordinary struct member load rather than a dynamic lookup -- and
  // `staticKeyType` is right for it for the same reason it is right for
  // `o[0]`: what the operand carries is the key's canonical *text*, never a
  // runtime symbol value (which a literal could not reproduce anyway, since
  // `Symbol()` mints a fresh one per evaluation).
  //
  // The same syntax over an INDEX SIGNATURE (`(o as Record<symbol, T>)[S]`) is
  // deliberately left computed: that is a real dynamic-table lookup keyed by
  // the symbol's runtime value, and spelling it as a static text would file it
  // under the string half of the object's key space, where `Object.keys` would
  // list a property whose whole purpose is not being enumerated.
  // `symbolMemberKeyOf` asks the receiver's own shape which of the two this is.
  const symbolKey = symbolMemberKeyOf(context, node.expression, argumentType)
  if (symbolKey !== null) {
    return { kind: 'key', computed: false, source: { kind: 'constant', text: symbolKey, literal: 'string' }, type: staticKeyType }
  }
  const cited = citeExpressionResult(argument, context)
  if (cited.kind === 'unmodelled') return { kind: 'blocked', reason: cited.reason, missingPrimitive: null }
  return { kind: 'key', computed: true, source: cited.source, type: argumentType }
}

/**
 * What the `[[Get]]` inside `a?.b` produces.
 *
 * The checker types the whole expression `T | undefined`, and only part of that
 * `undefined` belongs to the operator. The rest can be the property's own:
 * `w.options?.name` where `name?: string` is `string | undefined` for two
 * independent reasons, and stripping both would tell the backend the read
 * yields a `string` wherever the receiver was present -- which it does not when
 * the property is simply absent.
 *
 * So the strip is licensed rather than assumed. The property's type on the
 * *narrowed* receiver is asked, and the `undefined` is removed only when that
 * type has none of its own. A key this cannot ask about -- a computed one, an
 * index signature, a receiver with no such property -- keeps the union, which
 * is wider than the truth and never narrower than it.
 */
const presentValueTypeOf = (
  node: AccessNode,
  key: Extract<KeyResolution, { kind: 'key' }>,
  valueType: StructuralTypeId,
  context: ProducerContext
): StructuralTypeId => {
  if (key.source.kind !== 'constant') return valueType
  // The `undefined` an arm lacking the member answers is the READ's, not the
  // operator's; the asserted receiver below declares the member and would
  // take it off.
  if (assertedReadMayLackMember(context, node)) return valueType
  // HOLDS: the receiver, read the census-aware way (`context.types.rawTypeAt`)
  // rather than the bare checker -- an under-typed receiver the parameter/
  // return census resolved must not fall back to `any` here, or
  // `getPropertyOfType` below finds nothing and this whole strip silently
  // never fires.
  const receiver = context.checker.getNonNullableType(context.types.rawTypeAt(node.expression))
  const property = context.checker.getPropertyOfType(receiver, key.source.text)
  // An optional property declares its own `undefined` in the modifier rather
  // than in the type, and a location-sensitive read can hand it back already
  // stripped, so the modifier is consulted first and believed.
  if (!property || (property.flags & ts.SymbolFlags.Optional) !== 0) return valueType
  // STATED: the resolved member's own type at this read location -- given a
  // real property symbol (found above, on the now-census-corrected
  // receiver), its declared/narrowed type is the checker's own question to
  // answer, not one a census re-derives.
  if (!excludesNullish(context.checker.getTypeOfSymbolAtLocation(property, node))) return valueType
  // HOLDS: this read's own value, which is `valueType` -- already the
  // census-aware, callee-aware answer for this exact node -- with the
  // operator's absence taken off. Re-deriving it from the checker
  // (`typeOf(getNonNullableType(rawTypeAt(node)))`) threw away every
  // node-keyed correction the mapper had made and published the checker's
  // raw reading instead: `host.realpath?.bind(host)` came back as
  // `Function.prototype.bind`'s five-overload set --
  // `unresolved(no primitive joining 2 overload signatures)` -- while the
  // non-optional `host.readFile.bind(host)` beside it resolved fine. One
  // read, two authorities, and the strip was the only place they parted.
  return withoutAbsentMembers(context, valueType)
}

/** One structural type with its `undefined`/`null` members removed -- the absence an optional chain's operator adds, taken back off. */
const withoutAbsentMembers = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return type
  const members = shape.members.filter((member) => {
    const own = context.table.get(member).shape
    return own.kind !== 'primitive' || (own.primitive !== 'undefined' && own.primitive !== 'null')
  })
  if (members.length === 0 || members.length === shape.members.length) return type
  return members.length === 1 ? members[0]! : context.table.intern({ kind: 'union', members })
}

/** The function-object protocol's own keys -- see `fixedCallableSurface`'s use below. */
const fixedCallableSurface = new Set(['name', 'length', 'prototype', 'caller', 'arguments'])

/**
 * A callable's own non-fixed property, read at its DECLARED (never narrowed)
 * type, or `null` for every access this does not apply to.
 *
 * A callable value's own extra properties -- `validate.errors`,
 * `callableConstructor.sidecar` -- live in one shared, boxed `properties`
 * table on the callable's identity (`gea::callableDynamicGet`), reachable
 * through `Reflect.set`/`Object.defineProperty`/a computed write the checker
 * never models as an assignment to THIS property. TypeScript's control-flow
 * narrowing is sound only against assignments syntactically visible to it --
 * `callableConstructor.sidecar = 7` narrows the next read to `number`, a
 * `delete` narrows it to `undefined`, and neither narrowing is ever
 * invalidated by a `Reflect.set` that does the exact same write through a
 * call the analysis does not track. An ordinary struct field has no such gap:
 * its storage IS the declared type, so a narrowed read only ever narrows how
 * the call is RENDERED, never what the runtime can hold there. A callable's
 * sidecar has no struct field -- narrowing it therefore narrows what the
 * runtime is TRUSTED to hold, and `Reflect.set(callableConstructor,
 * 'sidecar', 8)` right before this exact read (`callable-intersection.ts`)
 * is a real, spec-legal write a narrowed `unboxAs<gea::Undefined>` aborts on.
 *
 * `checker.getTypeOfSymbol` is TypeScript's own "ignore control flow" escape
 * hatch: the member's declared type is, by definition, every value any
 * write -- visible to the checker or not -- may legally store. Excluded: a
 * callee position (`calleeAwareTypeAt` owns that, and correctly narrows to
 * the resolved signature actually invoked) and a computed key (handled
 * entirely dynamically elsewhere already).
 */
const declaredMemberTypeOf = (context: ProducerContext, node: AccessNode): StructuralTypeId | null => {
  if (!ts.isPropertyAccessExpression(node)) return null
  const call = enclosingCallIfCallee(node)
  if (call !== null) return null
  const receiverType = context.checker.getTypeAtLocation(node.expression)
  const isCallable =
    context.checker.getSignaturesOfType(receiverType, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(receiverType, ts.SignatureKind.Construct).length > 0
  if (!isCallable) return null
  // The function-object's OWN fixed surface is not a sidecar and is not ours
  // to answer. `name`, `length` and `prototype` are decided by the callable
  // arm of `objectDescriptorReturnTypeAt`/`valueIdOfShape`
  // (semantics/normalize/structural.ts), which knows whether the callable is a
  // real function and what each key means for it. Claiming them here made this
  // a SECOND authority on one question, and it silently retyped every
  // reflective read of a builtin method -- `Date.prototype.getTime.length`,
  // `RegExp.prototype.test.name` -- taking ten Date/prototype-reflection
  // fixtures with it. A sidecar is what is left once the fixed surface is
  // excluded.
  if (fixedCallableSurface.has(node.name.text)) return null
  const symbol = context.checker.getSymbolAtLocation(node.name)
  if (symbol === undefined) return null
  return context.types.typeOf(context.checker.getTypeOfSymbol(symbol))
}

const primitiveReadIsAbsent = (context: ProducerContext, node: AccessNode): boolean =>
  ts.isPropertyAccessExpression(node) &&
  intentOf(node).kind === 'get' &&
  primitivePropertyIsAbsent(node.expression, context.types.typeAt(node.expression), node.name.text, context)

const provenNumericReadIsAbsent = (context: ProducerContext, node: AccessNode): boolean =>
  ts.isElementAccessExpression(node) &&
  intentOf(node).kind === 'get' &&
  node.argumentExpression !== undefined &&
  context.numericIndexAbsenceProvenAt?.(node.expression, node.argumentExpression) === true

/**
 * A named read (`x.name` or its bracket spelling `x[ 'name' ]`) proven absent
 * from every instance of a closed object-literal record -- `getParameters()`'s
 * `parameters.morphAttributeCount` in three's `WebGLPrograms.js` is the
 * motivating case: `closedLiteralMemberAbsenceProvenAt` (wired from
 * `closedLiteralMemberAbsenceProven`) is the ONLY thing that licenses treating
 * this GET as a compile-time `undefined` rather than a runtime lookup -- a
 * `record` receiver is typically `owned` (a by-value struct with no stable
 * identity), so the generic dynamic-property-sidecar path this function's
 * caller falls back to for an unmatched key cannot run for it at all.
 */
const provenClosedLiteralMemberReadIsAbsent = (context: ProducerContext, node: AccessNode): boolean => {
  if (intentOf(node).kind !== 'get') return false
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? literalMemberNameOf(node) : null
  return name !== null && context.closedLiteralMemberAbsenceProvenAt?.(node.expression, name) === true
}

const normalReadIsAbsent = (context: ProducerContext, node: AccessNode): boolean =>
  primitiveReadIsAbsent(context, node) || provenNumericReadIsAbsent(context, node) || provenClosedLiteralMemberReadIsAbsent(context, node)

/** See `asserted-arm-absence.ts`; a read (not a store) at this exact node. */
const assertedReadMayLackMember = (context: ProducerContext, node: AccessNode): boolean =>
  intentOf(node).kind === 'get' && assertedReceiverArmMayLackMember(context.checker, node, (receiver) => context.types.rawTypeAt(receiver))

const propertyValueTypeAt = (context: ProducerContext, node: AccessNode): StructuralTypeId => {
  const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })
  if (normalReadIsAbsent(context, node)) return undefinedType
  const own = declaredMemberTypeOf(context, node) ?? calleeAwareTypeAt(context, node)
  return assertedReadMayLackMember(context, node) ? context.table.intern({ kind: 'union', members: [own, undefinedType] }) : own
}

/**
 * The type an optional chain's own expression result publishes.
 *
 * The access's value type plus the `undefined` the operator produces. The
 * value type is the CALLEE-AWARE one, for the same reason the `[[Get]]`'s own
 * result uses it: `symbol.declarations?.find(isClassLike)` reads `find` for
 * one call, and that call's resolved signature is the one type the access has
 * there. The member's declared type is BOTH of `Array.prototype.find`'s
 * overloads, which no single calling convention joins, so publishing it here
 * put `unresolved(no primitive joining 2 overload signatures ...)` on the
 * chain's result -- 20 of tsc's `checker.ts` rows, every one
 * `x.declarations?.find(...)` -- while the very same access certified without
 * the `?.`.
 *
 * The `undefined` arm is the OPERATOR's and is stated whenever it could be
 * missing from `own`: when the checker has decided the receiver cannot be
 * nullish (see the call site for why that decision is not one this compiler
 * can adopt), and when the callee-aware type replaced the checker's, because
 * a resolved signature says what the method returns and nothing about the
 * branch on which it does not run. The earlier attempt published the
 * callee-aware type WITHOUT that arm, and the merge then had to store the
 * operator's `undefined` into a function carrier. An answer that is the
 * checker's own and already nullish is returned untouched, so the ordinary
 * chain is unaffected and no carrier moves.
 */
const chainValueTypeOf = (context: ProducerContext, node: AccessNode): StructuralTypeId => {
  const checkers = context.types.typeAt(node)
  const own = propertyValueTypeAt(context, node)
  if (own === checkers && !excludesNullish(context.types.rawTypeAt(node))) return own
  return context.table.intern({ kind: 'union', members: [own, context.table.intern({ kind: 'primitive', primitive: 'undefined' })] })
}

/**
 * Whether an expression sits where ECMA-262 turns its value into a BOOLEAN --
 * `ToBoolean` of whatever it evaluated to -- rather than where the value
 * itself is consumed.
 *
 * These are test positions that can observe an `undefined` no type mentions.
 * Equality with `undefined` is the other direct observation. See
 * `observablyAbsentElementTypeOf` for why the widening is bounded to them.
 */
const testsItsOperand = (node: ts.Expression): boolean => {
  let inner: ts.Node = node
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
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind
    const tested =
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    return tested && parent.left === inner
  }
  // `?.` IS a test of its base, and the one that consumes nothing on the
  // absent branch: ECMA-262 13.3.9.1 evaluates the whole chain to `undefined`
  // without ever performing the `[[Get]]`. `root.children[3]?.value` therefore
  // needs the same widening `if (array[i])` gets -- without it the base's
  // carrier says never-absent, the chain's guard folds to `if (true)`, and
  // `elementAt` aborts on the read the program wrote `?.` precisely to avoid.
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) {
    return parent.expression === inner && ts.isOptionalChain(parent) && parent.questionDotToken !== undefined
  }
  return false
}

/** A test that consumes this value immediately, including a logical assignment's own guard. */
const directlyTestsItsOperand = (node: ts.Expression): boolean => {
  let inner: ts.Node = node
  let parent = inner.parent
  while (parent && ts.isParenthesizedExpression(parent)) {
    inner = parent
    parent = parent.parent
  }
  if (!parent) return false
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === inner
  if (ts.isForStatement(parent)) return parent.condition === inner
  if (ts.isConditionalExpression(parent)) return parent.condition === inner
  if (ts.isBinaryExpression(parent) && parent.left === inner) return logicalAssignmentOperators.has(parent.operatorToken.kind)
  return ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken
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
 * Whether this compiler has normalized the receiver as an index-signature
 * object for the key at this access. This asks the same structural source of
 * truth the representation layer will later turn into a dictionary; asking
 * only the checker would miss an empty object whose object-bag census learned
 * its value type from indexed writes.
 */
const isIndexedObjectFor = (
  context: ProducerContext,
  type: StructuralTypeId,
  key: 'string' | 'number' | 'symbol',
  visiting: Set<StructuralTypeId> = new Set()
): boolean => {
  if (visiting.has(type)) return false
  const next = new Set(visiting)
  next.add(type)
  const shape = context.table.get(type).shape
  if (shape.kind === 'union')
    return shape.members.length > 0 && shape.members.every((member) => isIndexedObjectFor(context, member, key, next))
  if (shape.kind === 'declared' || shape.kind === 'class-instance' || shape.kind === 'object-anchor') {
    return shape.body !== null && isIndexedObjectFor(context, shape.body, key, next)
  }
  if (shape.kind !== 'object') return false
  return shape.index.some((index) => index.key === key || (key === 'number' && index.key === 'string'))
}

/**
 * An indexed read whose consumer can observe absence, as `T | undefined`.
 *
 * ECMA-262 gives no other answer: `[[Get]]` on an Array with an index that is
 * not a present element runs OrdinaryGet (10.1.8.1), finds no property, and
 * returns `undefined` -- unconditionally, exactly the way an optional chain
 * evaluates to `undefined` for a nullish base. `lib.es5.d.ts`'s number index
 * signature says `T` instead, which is a convenience the checker offers (and
 * withdraws under `noUncheckedIndexedAccess`), not a fact about the read.
 * hono's `compose` relies on the real rule: `if (middleware[i])` walks off the
 * end of the array on the 404 path, and under the checker's carrier that guard
 * compiled to `if (true)` and the read aborted in `ArrayObject::elementAt`.
 *
 * Bounded to a test position, and that bound is not timidity: everywhere else
 * the program goes on to USE the value, and a carrier with an absence the
 * consumer has no home for turns one honest read into a conversion the whole
 * chain has to answer for. A test consumes nothing -- `ToBoolean(undefined)`
 * is `false` (7.1.2) -- so the widening is free of that, and the emitter
 * already renders the guarded read (`emit-carrier-members.ts`'s
 * `absentCapableElementText`) as soon as the carrier admits absence.
 *
 * A TUPLE is excluded: its element types are positional facts, and the checker
 * states out-of-range for one as an error rather than a silent `T`.
 */
const observablyAbsentElementTypeOf = (context: ProducerContext, node: AccessNode, valueType: StructuralTypeId): StructuralTypeId => {
  // The local-binding census connects `const value = array[index]` to a later
  // direct `value === undefined` observation. Structural array reads normally
  // derive their bare element from the receiver before layout overrides run,
  // so honor that precise preferred answer here, where the [[Get]] result is
  // published. This is the same optional carrier the existing guarded array
  // emitter already consumes; unrelated reads have no preferred answer.
  const observedAbsence = context.parameters.preferredTypeAt?.(node)
  if (observedAbsence && includesUndefined(observedAbsence)) return context.types.typeOf(observedAbsence)
  const key = ts.isElementAccessExpression(node) ? context.types.rawTypeAt(node.argumentExpression) : null
  const numeric = key !== null && (key.flags & ts.TypeFlags.NumberLike) !== 0
  const symbol = key !== null && (key.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) !== 0
  if (ts.isPropertyAccessExpression(node) && context.checker.getPropertyOfType(context.types.rawTypeAt(node.expression), node.name.text))
    return valueType

  // A dictionary's `read` alone cannot distinguish a missing key from the
  // default value of its payload carrier. When the consumer explicitly has a
  // home for `undefined` -- an annotated return, declaration initializer, or
  // assignment target as reported by the checker's contextual type -- publish
  // that absence at the read itself. The C++ dictionary emitter can then use
  // `has(key)` and leave the optional empty; waiting until the return/store
  // conversion would wrap the already-defaulted payload as PRESENT.
  const contextual = context.checker.getContextualType(node)
  const receiverType = context.types.typeAt(node.expression)
  const indexedObject = isIndexedObjectFor(context, receiverType, symbol ? 'symbol' : numeric ? 'number' : 'string')
  if (
    ((contextual !== undefined && includesUndefined(contextual)) ||
      comparesWithUndefined(context, node) ||
      directlyTestsItsOperand(node)) &&
    indexedObject &&
    excludesNullish(context.types.rawTypeAt(node))
  ) {
    return context.table.intern({
      kind: 'union',
      members: [valueType, context.table.intern({ kind: 'primitive', primitive: 'undefined' })]
    })
  }

  if (!ts.isElementAccessExpression(node) || !testsItsOperand(node)) return valueType
  // Each constituent, because a union of array types indexes the same way:
  // hono's `compose` declares `middleware: [[Function, unknown], unknown][] |
  // [[Function]][]`, and asking `isArrayType` of the union answers no.
  const receiver = context.types.rawTypeAt(node.expression)
  const constituents = receiver.isUnion() ? receiver.types : [receiver]
  const indexable = (one: ts.Type): boolean => context.checker.isArrayType(one) && !context.checker.isTupleType(one)
  if (!constituents.every(indexable)) return valueType
  if (!numeric) return valueType
  if (!excludesNullish(context.types.rawTypeAt(node))) return valueType
  return context.table.intern({ kind: 'union', members: [valueType, context.table.intern({ kind: 'primitive', primitive: 'undefined' })] })
}

/**
 * The value type published for this exact property expression.
 *
 * Consumers cite the property producer's result by identity, so they must cite
 * its type from the same rule as well. In particular, an indexed dictionary
 * read can publish `T | undefined` even when TypeScript's unchecked index
 * signature reports only `T`; asking the checker again at a conditional merge
 * erases the missing-key state the property operation deliberately restored.
 * Optional chains cite their whole-expression result, including the synthetic
 * `undefined` branch, rather than the present-only internal `[[Get]]` result.
 */
export const propertyExpressionValueTypeAt = (context: ProducerContext, node: AccessNode): StructuralTypeId => {
  const valueType = observablyAbsentElementTypeOf(context, node, propertyValueTypeAt(context, node))
  return publishesShortCircuit(node) && !isAlwaysPresentHostExpression(node.expression, context)
    ? chainValueTypeOf(context, node)
    : valueType
}

const buildOperations = (
  candidate: CensusCandidate,
  node: AccessNode,
  intent: Exclude<PropertyIntent, { kind: 'blocked-logical-assignment' }>,
  key: Extract<KeyResolution, { kind: 'key' }>,
  receiverSource: OperandSource,
  context: ProducerContext,
  resolvedBinding: DeclarationId | null,
  resolvedGlobalBinding: boolean
): { readonly operations: PropertyOperation[]; readonly edges: SemanticEdge[] } => {
  // A property access that is itself an invocation's callee reads its value
  // type off that call's own resolved signature rather than off the property
  // in isolation -- see `calleeAwareTypeAt`'s own comment for why that is
  // exact, not an approximation, for this one occurrence of the access.
  const valueType = observablyAbsentElementTypeOf(context, node, propertyValueTypeAt(context, node))
  // `a?.b` is typed `T | undefined` by the checker, and both halves are needed:
  // the whole expression really is that union, while the `[[Get]]` inside it
  // produces a `T` and never an `undefined` -- it does not run at all on the
  // branch where the receiver was absent. `getNonNullableType` is the language's
  // own answer to which type that is, asked rather than reconstructed.
  const shortCircuits = publishesShortCircuit(node)
  const shortCircuitAlwaysPresent = shortCircuits && isAlwaysPresentHostExpression(node.expression, context)
  // A computed key's proven finite name set (`PropertyOperation.provenKeyTexts`'s
  // own comment has the full contract). Asked only for a genuinely computed
  // element access -- a static key already carries its text as the key
  // operand's own constant, and `key.computed` is false for every
  // property-access spelling -- and published as nothing at all when the hook
  // is absent or refuses, which is the fail-closed default this producer must
  // never weaken.
  const provenKeyTexts: readonly string[] | undefined =
    key.computed && ts.isElementAccessExpression(node) ? (context.computedKeyTextsOf?.(node.argumentExpression) ?? undefined) : undefined
  const guardExpression = optionalChainGuardOf(node)
  const guardSource = guardExpression === null ? null : sourceForValue(context, guardExpression)
  const presentValueType = shortCircuits ? presentValueTypeOf(node, key, valueType, context) : valueType
  // What the *expression* evaluates to is the checker's own type for it, never
  // the callee-aware one. The two part company at exactly one place: an access
  // that is a call's callee, where `calleeAwareTypeAt` deliberately answers
  // with the method's own signature -- correct for the `[[Get]]`'s value, and
  // wrong for a result that must also carry the `undefined` the operator
  // produces on the other branch. Publishing the callee-aware type here made
  // the merge try to store `undefined` into a function carrier.
  //
  // And the `undefined` is the OPERATOR's, so it is stated here rather than
  // taken on trust from the checker's type for the node. ECMA-262 13.3.9.1
  // evaluates an optional chain to `undefined` whenever the base is nullish,
  // which is unconditional -- but the checker drops that arm from the
  // expression's type whenever it believes the receiver cannot be nullish, and
  // an `as` assertion is enough to make it believe that. hono's
  // `resolveCallback` is the case: `(str as HtmlEscapedString).callbacks as
  // HtmlEscapedCallback[]` gives `callbacks` a non-nullable type, so
  // `callbacks?.length` is typed plain `number` while the cell the value came
  // from is still an optional this compiler placed from the initializer's own
  // type. `publishesShortCircuit` is syntactic and builds both arms either
  // way, so the merge then had to store `undefined` into a `scalar(number)`
  // and refused.
  //
  // Widening rather than dropping the arm, deliberately: the other repair is
  // to believe the non-nullish claim and emit the access unguarded, which
  // trades a compile error for an unchecked read of an absent optional on a
  // path hono takes on every call.
  const expressionValueType = shortCircuits && !shortCircuitAlwaysPresent ? chainValueTypeOf(context, node) : context.types.typeAt(node)
  // Only a link carrying ?. proves its own receiver present. A plain suffix
  // such as a?.b.c is gated on a, and must still throw when b itself is absent.
  // Its cited present value removes only the chain's synthetic undefined;
  // any absence belonging to the property remains in that value's carrier.
  // A non-null assertion erases; it must not license a presence conversion
  // before the property read can perform its runtime nullish check.
  let receiverExpression: ts.Expression = node.expression
  let receiverWasAsserted = false
  while (
    ts.isNonNullExpression(receiverExpression) ||
    ts.isParenthesizedExpression(receiverExpression) ||
    ts.isAsExpression(receiverExpression) ||
    ts.isTypeAssertionExpression(receiverExpression)
  ) {
    // In JavaScript, `/** @type {T} */ (value)` is represented as a
    // ParenthesizedExpression carrying a JSDoc type tag, not as an
    // AsExpression. It is nevertheless the same explicit runtime assertion:
    // when the wrapped value is `any`/`unknown`, this property read must use
    // the asserted receiver type so lowering emits the checked unbox before
    // native member lookup. Missing this case left the result type narrowed
    // (the checker sees `T.clone`) while the receiver stayed dynamic, yielding
    // a boxed `getProperty("clone")` on a class whose methods live on its
    // prototype.
    const jsDocTypeAssertion = ts.isParenthesizedExpression(receiverExpression) && ts.getJSDocTypeTag(receiverExpression) !== undefined
    receiverWasAsserted ||= ts.isAsExpression(receiverExpression) || ts.isTypeAssertionExpression(receiverExpression) || jsDocTypeAssertion
    receiverExpression = receiverExpression.expression
  }
  // A type assertion does not inspect or replace the receiver at runtime.
  // Preserve a statically known union so its property read dispatches on the
  // actual arm. Loading the asserted arm unconditionally turns a harmless
  // missing property on a string into an invalid native record dereference.
  // A genuinely unknown receiver still needs the assertion's checked unbox.
  if (receiverWasAsserted) {
    const physicalReceiverShape = context.table.get(context.types.typeAt(receiverExpression)).shape
    if (
      physicalReceiverShape.kind === 'primitive' &&
      (physicalReceiverShape.primitive === 'any' || physicalReceiverShape.primitive === 'unknown')
    )
      receiverExpression = node.expression
  }
  const guardsReceiver = node.questionDotToken !== undefined
  const receiverType = guardsReceiver
    ? context.types.typeOf(context.checker.getNonNullableType(context.types.rawTypeAt(receiverExpression)))
    : context.types.typeAt(receiverExpression)
  const canThrow = !guardsReceiver && !excludesNullish(context.types.rawTypeAt(receiverExpression))
  const completion = canThrow ? throwingCompletion : normalCompletion
  const booleanResultType = context.table.intern({ kind: 'primitive', primitive: 'boolean' })
  const reads: EffectBehavior = { ...pureEffects, readsMutableState: true }
  const writes: EffectBehavior = { ...pureEffects, writesMutableState: true }
  const runtime: OperandEvaluation = { kind: 'runtime' }
  const provenance: OperandEvaluation = { kind: 'provenance' }

  /**
   * The value a `[[Set]]` at this site stores.
   *
   * It is the result of the computation at the assignment or update node --
   * `x` for `o.p = x`, the sum for `o.p += x`, the incremented number for
   * `o.p++`. Citing that one operation is what keeps "the value written" from
   * having two answers: this producer never re-derives it from the right-hand
   * side, which for a compound assignment would be the wrong value entirely.
   */
  const storedValue = (): OperandSource | null => {
    // Read through erasure for the same reason `intentOf` does, and it must be
    // the SAME reading: the intent decides that a store happens and this
    // decides which value it stores, so a disagreement between them would
    // publish a `[[Set]]` citing a computation at a node that has none.
    const parent = outermostErasureOf(node).parent
    const assignment = ts.isBinaryExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)
    if (!assignment) return null
    // A logical assignment is the one shape where the computation's result is
    // NOT what gets stored: that result is the merge of both branches, and
    // storing it would write the property's own old value back over itself on
    // the branch where the language performs no store at all -- observable
    // through a setter, and a spurious mutation regardless. What it stores is
    // the right-hand side, which is exactly what this `[[Set]]` is gated on
    // having evaluated.
    if (intent.kind === 'logical-set' && ts.isBinaryExpression(parent)) return sourceForValue(context, parent.right)
    return { kind: 'result', result: semanticResultId(operationId(context.identities.nodeIdOf(parent), 'computation', 0), 'value') }
  }

  const makeOperation = (
    internalMethod: PropertyOperation['internalMethod'],
    receiverEvaluation: OperandEvaluation,
    keyEvaluation: OperandEvaluation,
    effects: EffectBehavior
  ): PropertyOperation => {
    const id = mintOperationId(context.ordinals, candidate.id, 'property')
    const stored = internalMethod === 'set' ? storedValue() : null
    const hostMethod = internalMethod === 'get' ? context.hostMethodOf?.(node) : null
    const intrinsicValue =
      internalMethod === 'get' &&
      !key.computed &&
      key.source.kind === 'constant' &&
      key.source.text === 'prototype' &&
      isGlobalFunctionConstructor(context.checker, node.expression, context.checker.getTypeAtLocation(node.expression))
        ? 'function-prototype'
        : null
    return {
      ...(hostMethod ? { hostMethod } : {}),
      ...(internalMethod === 'get' && resolvedBinding !== null ? { resolvedBinding } : {}),
      ...(internalMethod === 'get' && resolvedGlobalBinding ? { resolvedGlobalBinding: true as const } : {}),
      ...(internalMethod === 'get' && shortCircuitAlwaysPresent ? { shortCircuitAlwaysPresent: true as const } : {}),
      ...(intrinsicValue ? { intrinsicValue } : {}),
      ...(internalMethod === 'get' && normalReadIsAbsent(context, node) ? { normalResult: 'undefined' as const } : {}),
      ...(provenKeyTexts ? { provenKeyTexts } : {}),
      id,
      family: 'property',
      internalMethod,
      strict: isStrictContext(node, context.buildIsStrict),
      keyIsComputed: key.computed,
      // A property access consults the descriptor already installed on the
      // object; it never states one of its own.
      descriptor: null,
      caller: candidate.caller,
      operands: [
        operand('receiver', 0, receiverSource, receiverType, receiverEvaluation),
        operand('key', 0, key.source, key.type, keyEvaluation),
        ...(stored ? [operand('value', 0, stored, valueType)] : []),
        ...(guardSource && guardExpression
          ? [operand('short-circuit-guard', 0, guardSource, context.types.typeAt(guardExpression), { kind: 'provenance' })]
          : [])
      ],
      // A store's result is the receiver it wrote into, threaded onward. The
      // internal method's own answer is a success boolean, which nothing can
      // consume and which no native field store can ever report false; what a
      // consumer actually needs is the object *after* the write, and naming it
      // here is what orders a later reader after the store instead of leaving
      // the two unordered and hoping the tie-break lands the right way. The
      // enclosing expression's own value -- `v` in `o.x = v` -- is published by
      // the computation that owns the assignment, not by this.
      // An optional chain publishes a second result, and the two are different
      // values. `value` is the property, which exists only on the branch where
      // the receiver was present; `short-circuit` is what the *expression*
      // evaluates to, which is that property on one branch and `undefined` on
      // the other. A consumer of `a?.b` wants the second -- that is the whole
      // meaning of the operator -- and the first is what the `[[Get]]` itself
      // produced, which nothing outside the present branch may read.
      // `delete` and `in` publish a BOOLEAN, not the property's own type.
      // `[[Delete]]` answers "the property is gone" (ECMA-262 13.5.1.2 step 5)
      // and `[[HasProperty]]` answers "the key resolves" (13.10.2 step 7); the
      // property's type describes what a *read* would produce and no read
      // happens at either site. Publishing `valueType` for them told the
      // backend a `delete` yielded whatever the property held, which for an
      // `any`-typed property meant a boxed carrier where the operator's answer
      // is a `bool`.
      results:
        internalMethod === 'get' && shortCircuits
          ? [mintResult(id, 'value', presentValueType), mintResult(id, 'short-circuit', expressionValueType)]
          : [
              mintResult(
                id,
                'value',
                internalMethod === 'set'
                  ? receiverType
                  : internalMethod === 'delete' || internalMethod === 'has-property'
                    ? booleanResultType
                    : valueType
              )
            ],
      completion,
      effects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
  }

  switch (intent.kind) {
    case 'get': {
      const get = makeOperation('get', runtime, runtime, reads)
      // The `[[Get]]` runs only where the receiver is present. Stating that as a
      // conditional edge rather than as a flag on the operation is what lets one
      // machinery serve `if (a)`, `a && b` and `a?.b`: all three are a guard, a
      // gated region, and a join, and only the question asked of the guard
      // differs.
      if (!shortCircuits || shortCircuitAlwaysPresent || guardSource?.kind !== 'result') return { operations: [get], edges: [] }
      return {
        operations: [get],
        edges: [{ kind: 'conditional', guard: guardSource.result, to: get.id, takenWhen: 'present' }]
      }
    }
    case 'set':
      return { operations: [makeOperation('set', runtime, runtime, writes)], edges: [] }
    case 'delete':
      return { operations: [makeOperation('delete', runtime, runtime, writes)], edges: [] }
    case 'logical-set': {
      // The get is the guard, so it is not gated; the set is, on the get's own
      // published value. Stated as a `conditional` edge because an edge is what
      // places an OPERATION -- `normalize/gating.ts` places the right-hand
      // subtree, and `producers/computations.ts` publishes the merge. The
      // receiver and key are evaluated once, by the get, exactly as in
      // `get-then-set`: `a[b()] ??= 1` calls `b` once even though both internal
      // methods run.
      const get = makeOperation('get', runtime, runtime, reads)
      const set = makeOperation('set', provenance, provenance, writes)
      const guard = get.results[0]
      if (!guard) {
        return {
          operations: [get],
          edges: []
        }
      }
      return {
        operations: [get, set],
        edges: [
          { kind: 'evaluation', from: get.id, to: set.id },
          { kind: 'conditional', guard: guard.id, to: set.id, takenWhen: intent.takenWhen }
        ]
      }
    }
    case 'get-then-set': {
      // The receiver and key are evaluated once, by the get; the set reuses
      // that same evaluation, exactly as the language evaluates `a[b()] += 1`'s
      // `a` and `b()` a single time even though both [[Get]] and [[Set]] run.
      const get = makeOperation('get', runtime, runtime, reads)
      const set = makeOperation('set', provenance, provenance, writes)
      return { operations: [get, set], edges: [{ kind: 'evaluation', from: get.id, to: set.id }] }
    }
  }
}

/** The live exported binding named by `namespace.member`, or `null`. */
const namespaceMemberBindingOf = (
  node: AccessNode,
  key: Extract<KeyResolution, { kind: 'key' }>,
  context: ProducerContext
): DeclarationId | null => {
  if (key.computed || key.source.kind !== 'constant') return null
  const receiver = node.expression
  if (!ts.isIdentifier(receiver)) return null
  const namespace = context.checker.getSymbolAtLocation(receiver)
  if (!namespace?.declarations?.some((declaration) => ts.isNamespaceImport(declaration))) return null
  const member = ts.isPropertyAccessExpression(node)
    ? context.checker.getSymbolAtLocation(node.name)
    : context.checker.getPropertyOfType(context.types.rawTypeAt(receiver), key.source.text)
  return member ? context.identities.symbolValueDeclarationId(member, node) : null
}

/**
 * The existing ambient binding named by an intrinsic-global-object property.
 *
 * `globalThis.process` and bare `process` are two language routes to the same
 * global binding.  Only a host-authenticated singleton or namespace root is
 * admitted here; an ordinary expando remains a property of the open global
 * dictionary.  The receiver must be TypeScript's declarationless intrinsic
 * `globalThis`, so a caller-owned variable with that spelling cannot acquire
 * host provenance.
 */
const hostGlobalMemberDeclarationOf = (
  node: AccessNode,
  key: Extract<KeyResolution, { kind: 'key' }>,
  context: ProducerContext
): DeclarationId | null => {
  if (key.source.kind !== 'constant') return null
  const receiver = unwrapErasedExpression(node.expression)
  if (!ts.isIdentifier(receiver) || !context.unresolvableNames.isIntrinsicGlobalThis(receiver)) return null
  const member = ts.isPropertyAccessExpression(node)
    ? context.checker.getSymbolAtLocation(node.name)
    : context.checker.getPropertyOfType(context.types.rawTypeAt(receiver), key.source.text)
  if (!member) return null
  const declaration = context.identities.symbolValueDeclarationId(member, node)
  if (declaration === null) return null
  if (!context.hostSingletonBindings.has(declaration) && !context.hostNamespaceBindings.has(declaration)) return null
  return declaration
}

const hostGlobalMemberBindingOf = (
  node: AccessNode,
  key: Extract<KeyResolution, { kind: 'key' }>,
  context: ProducerContext
): DeclarationId | null => {
  const declaration = hostGlobalMemberDeclarationOf(node, key, context)
  if (declaration === null) return null
  return context.globalHostMutationTaint.has('*') || context.globalHostMutationTaint.has(declaration) ? null : declaration
}

/**
 * The program's own global-object property a read off the intrinsic global
 * object names.
 *
 * `var Headers: typeof HeadersImpl = HeadersImpl` in a script, then
 * `globalThis.Headers` in `@hono/node-server`'s `headers.ts`: 9.1.1.4 makes
 * the `var` an own property of the global object, so the read IS the `var`'s
 * cell -- the same live-binding answer `hostGlobalMemberDeclarationOf` gives
 * a host singleton, for the same reason. Reading it through the open expando
 * dictionary instead found nothing there (the dictionary holds only what the
 * program installed at run time) and aborted at startup on the unbox.
 *
 * Refused, like the host case, once the global-object-mutation census saw
 * the property changed through the object in a way that is not a plain store
 * to the var: the binding then has a writer this backend does not reconcile,
 * and a stale read would be a silently wrong answer. A value-only
 * `Object.defineProperty(globalThis, 'Request', { value })` IS a plain store
 * (`script-global-redefinition.ts`) and taints nothing.
 */
const scriptGlobalMemberDeclarationOf = (
  node: AccessNode,
  key: Extract<KeyResolution, { kind: 'key' }>,
  context: ProducerContext
): DeclarationId | null => {
  if (key.source.kind !== 'constant') return null
  const receiver = unwrapErasedExpression(node.expression)
  if (!ts.isIdentifier(receiver) || !context.unresolvableNames.isIntrinsicGlobalThis(receiver)) return null
  const member = ts.isPropertyAccessExpression(node)
    ? context.checker.getSymbolAtLocation(node.name)
    : context.checker.getPropertyOfType(context.types.rawTypeAt(receiver), key.source.text)
  const valueDeclaration = member?.valueDeclaration
  if (!member || valueDeclaration === undefined || !isScriptGlobalObjectPropertyDeclaration(valueDeclaration)) return null
  return context.identities.symbolValueDeclarationId(member, node)
}

/** Whether an expression is an authenticated host identity that cannot be nullish in this program. */
export const isAlwaysPresentHostExpression = (expression: ts.Expression, context: ProducerContext): boolean => {
  const current = unwrapErasedExpression(expression)
  if (ts.isIdentifier(current)) {
    if (context.unresolvableNames.isIntrinsicGlobalThis(current)) return true
    const symbol = context.checker.getSymbolAtLocation(current)
    const declaration = symbol ? context.identities.symbolValueDeclarationId(symbol, current) : null
    if (declaration === null) return false
    if (!context.hostSingletonBindings.has(declaration) && !context.hostNamespaceBindings.has(declaration)) return false
    return !context.globalHostMutationTaint.has('*') && !context.globalHostMutationTaint.has(declaration)
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false
  const key = keyOf(current, context)
  if (key.kind !== 'key') return false
  if (hostGlobalMemberBindingOf(current, key, context) !== null) return true
  return context.hostMethodOf?.(current) != null && isAlwaysPresentHostExpression(current.expression, context)
}

/**
 * Why a read of `instance.m` refuses when `m` was declared by `F.prototype.m =
 * function () {}` on a pre-`class` constructor function `F`.
 *
 * TypeScript puts such a member on `F`'s inferred instance type flagged
 * `SymbolFlags.Method`, and the instance layout leaves it out for the same
 * reason a `class` instance leaves its methods out (`structural-members.ts`'s
 * `data-only`): it is a prototype member, not per-instance storage. What a
 * `class` has and this constructor does not is a `class-ref` carrier with a
 * projected method table (`projection/classes.ts`), which is where a read of a
 * prototype method resolves to its body. A `record` has no such table and this
 * runtime models no prototype chain for one, so lowering the read as a dynamic
 * view over the instance's own fields could only ever find `undefined` and then
 * fail to unbox it as the callable the checker promised -- a certified program
 * that aborts on its first method call. Before the layout fix it was worse: the
 * method WAS a struct field, nothing ever wrote it, and the call segfaulted.
 *
 * Only a read through an INSTANCE refuses. `F.prototype.m` itself, read or
 * written, goes through the prototype object -- a boxed value whose expando
 * really does hold what the assignment stored -- and that path is sound.
 *
 * Refusing here rather than deeper keeps the defect in the census, ranked by
 * root, where the fix (model such a function as the class it is) can be
 * measured against it. The old `structural-declarations.ts` refusal that hid
 * this shape behind a construct-signature drop is gone; this is the honest
 * refusal it was standing in for.
 */
/**
 * Whether every instance this constructor makes is a boxed `DynamicObject`.
 *
 * `prototypeMutatedConstructorTypes` (semantics/dynamic-fallback.ts) marks the
 * return type of every construct signature under `--dynamic-fallback`, and
 * `Value::construct` links such an instance's `[[Prototype]]` to whatever
 * `F.prototype` holds. Spelled here exactly as the census spells it, so the
 * two ask one question: a constructor with no construct signature answers
 * `false`, because there is then no instance type that could have been marked.
 */
const constructedTypesAreBoxed = (constructor: ts.Expression, context: ProducerContext): boolean => {
  const signatures = context.checker.getTypeAtLocation(constructor).getConstructSignatures()
  if (signatures.length === 0) return false
  return signatures.every((signature) =>
    context.dynamicFallbackTypes.has(context.types.typeOf(context.checker.getReturnTypeOfSignature(signature)))
  )
}

const jsConstructorPrototypeMemberRefusalOf = (node: AccessNode, intent: PropertyIntent, context: ProducerContext): string | null => {
  if (intent.kind === 'set' || intent.kind === 'delete') return null
  const receiverExpression = unwrapErasedExpression(node.expression)
  if (ts.isPropertyAccessExpression(receiverExpression) && receiverExpression.name.text === 'prototype') return null
  const symbol = ts.isPropertyAccessExpression(node) ? context.checker.getSymbolAtLocation(node.name) : null
  if (!symbol) return null
  // EVERY declaration, not just one, and a DATA property is refused on the
  // same evidence as a method.
  //
  // Asking for `SymbolFlags.Method` scoped this to the shape that crashed, and
  // left the quieter half of the same defect answering. `Routed.prototype.kind
  // = 'route'` puts `kind` on the checker's instance type, so the record gets a
  // `std::string kind` field marked present -- and nothing ever writes it, so
  // `first.kind` reads `""` where the language reads `route`
  // (`dynamic-callable-abi-recovery.runtime.js`). A silently wrong answer is
  // the one outcome worse than the abort the method case produced.
  //
  // `every`, because a member the CONSTRUCTOR BODY also assigns (`this.kind =
  // ...` alongside `F.prototype.kind = 0`, the ordinary "declare a default,
  // then set it" pattern) has a declaration that is not a prototype assignment,
  // and its field really is written -- the prototype write is a default the
  // instance overwrites, not the only source of the value. Only a member whose
  // ONLY declaration is the prototype assignment has nothing to read.
  const declarations = symbol.getDeclarations() ?? []
  const onlyOnPrototype =
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        ts.isPropertyAccessExpression(declaration) &&
        ts.isPropertyAccessExpression(declaration.expression) &&
        declaration.expression.name.text === 'prototype'
    )
  if (!onlyOnPrototype) return null
  // Unless this program HAS a prototype chain for the instance. Under
  // `--dynamic-fallback`, `prototypeMutatedConstructorTypes` marks every
  // construct signature's return type, so the instance is a real
  // `DynamicObject` and `Value::construct` (gea_runtime.h) links its
  // `[[Prototype]]` to whatever `F.prototype` holds -- the read then finds
  // exactly what the language says it finds, through the same table the
  // assignment wrote. The premise of this refusal is the NATIVE carrier ("a
  // record with no prototype chain"), and where that premise is false the
  // refusal would be refusing a capability the program was given.
  //
  // Asked of the CONSTRUCTOR the prototype assignment names, in the same words
  // the census used -- `types.typeOf` of each construct signature's return
  // type -- rather than of the receiver expression here. Those are the ids the
  // census put in the set; `typeAt` on this read's own receiver is a different
  // derivation and would compare two things that only usually agree.
  const prototypeOwner = declarations[0]
  if (
    prototypeOwner !== undefined &&
    ts.isPropertyAccessExpression(prototypeOwner) &&
    ts.isPropertyAccessExpression(prototypeOwner.expression) &&
    constructedTypesAreBoxed(prototypeOwner.expression.expression, context)
  ) {
    return null
  }
  const what = (symbol.flags & ts.SymbolFlags.Method) !== 0 ? 'a method' : 'a data property'
  return (
    `"${symbol.name}" is ${what} assigned onto a pre-class constructor function's prototype; ` +
    'an instance of one is a record with no prototype chain and no method table, so the read can find nothing ' +
    '-- model the constructor as the class it is'
  )
}

const contributeAccess = (candidate: CensusCandidate, node: AccessNode, context: ProducerContext): CandidateContribution => {
  // `super.x`/`super.x(...)` used to be refused here by name -- a class
  // method's home object is a fully static fact (`references.ts`'s
  // `buildSuperReference`, which now publishes a value for the bare `super`
  // keyword typed as the class's base), so this access needs nothing special
  // once that receiver citation succeeds: it is an ordinary property/method
  // access on a `class-ref` receiver, exactly the path `this.x`/`obj.x`
  // already take, and `classMemberText` (emit-properties.ts) already starts
  // its member lookup from whichever class the receiver's representation
  // names -- here, the base, because that is what the citation published.

  const intent = intentOf(node)
  const key = keyOf(node, context)
  if (key.kind === 'blocked') return { kind: 'blocked', blocker: blocked(candidate.id, 'property', key.reason, key.missingPrimitive) }
  const globalDeclaration = hostGlobalMemberDeclarationOf(node, key, context)
  if (globalDeclaration !== null && (context.globalHostMutationTaint.has('*') || context.globalHostMutationTaint.has(globalDeclaration))) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'property',
        'an authenticated host global may be mutated through globalThis, so its native binding identity is not stable',
        'P0'
      )
    }
  }
  const scriptGlobalDeclaration = scriptGlobalMemberDeclarationOf(node, key, context)
  if (
    scriptGlobalDeclaration !== null &&
    (context.globalHostMutationTaint.has('*') || context.globalHostMutationTaint.has(scriptGlobalDeclaration))
  ) {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'property',
        "a script's global var is redefined through the global object (Object.defineProperty(globalThis, ...)), so a read of it through globalThis has two writers this backend does not reconcile",
        'P0'
      )
    }
  }

  const receiver = citeExpressionResult(
    node.expression,
    context,
    ts.isOptionalChain(node) && node.questionDotToken === undefined ? 'present' : 'expression'
  )
  if (receiver.kind === 'unmodelled') return { kind: 'blocked', blocker: blocked(candidate.id, 'property', receiver.reason, null) }
  const prototypeMember = jsConstructorPrototypeMemberRefusalOf(node, intent, context)
  if (prototypeMember !== null) return { kind: 'blocked', blocker: blocked(candidate.id, 'property', prototypeMember, null) }

  const namespaceBinding = intent.kind === 'get' ? namespaceMemberBindingOf(node, key, context) : null
  const globalBinding = intent.kind === 'get' ? (hostGlobalMemberBindingOf(node, key, context) ?? scriptGlobalDeclaration) : null
  const resolvedBinding = namespaceBinding ?? globalBinding
  const { operations, edges } = buildOperations(
    candidate,
    node,
    intent,
    key,
    receiver.source,
    context,
    resolvedBinding,
    globalBinding !== null
  )
  return { kind: 'operations', operations, edges }
}

export const createPropertyProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'property',
  contribute: (candidate) => {
    const node = candidate.node
    if (isObjectTagCalleePart(context, node)) return { kind: 'operations', operations: [], edges: [] }
    // A modelled `Object.setPrototypeOf(C.prototype, B.prototype)` is a class
    // lifecycle step, not a call through a function value, so its callee is
    // never read as one (`invocations.ts`'s `contributePrototypeReparenting`).
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node &&
      context.prototypeReparentings.of(node.parent) !== null
    )
      return { kind: 'operations', operations: [], edges: [] }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return contributeAccess(candidate, node, context)
    // census.ts assigns the 'property' family only to these two node kinds;
    // reaching here means the census and this producer have drifted apart.
    throw new Error(`property producer received a candidate of unexpected syntax kind ${ts.SyntaxKind[node.kind]}`)
  }
})
