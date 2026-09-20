import ts from 'typescript'
import { operationId, regionId, semanticResultId } from '../../../identity/ids.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import { objectAssignTargetType } from '../derived-expression-type.js'
import { keptLeftPartTypeOf } from '../logical-result-type.js'
import type { ProducerContext } from '../producer-context.js'
import { bindingKindOf } from './binding-kind.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import {
  isAssignmentOperatorKind,
  logicalAssignmentOperators,
  sourceForValue,
  symbolMemberKeyOf,
  unwrapErased,
  valueEdgesInto
} from './shared.js'
import type { SemanticEdge } from '../../model/edges.js'
import {
  normalCompletion,
  pureEffects,
  throwingCompletion,
  type CompletionBehavior,
  type EffectBehavior,
  type OperandSource,
  type SemanticOperand
} from '../../model/operands.js'
import type { BindingOperation, ComputationOperation } from '../../model/operations.js'
import { propertyExpressionValueTypeAt } from './properties.js'
import { objectCreateResultOverride } from './invocations.js'

type ComputationNode =
  | ts.BinaryExpression
  | ts.PrefixUnaryExpression
  | ts.PostfixUnaryExpression
  | ts.ConditionalExpression
  | ts.TemplateExpression
  | ts.TypeOfExpression
  | ts.VoidExpression
  | ts.DeleteExpression

const tokenText = (kind: ts.SyntaxKind): string => ts.tokenToString(kind) ?? ts.SyntaxKind[kind]

/**
 * The operator a compound assignment applies, or `null` for a plain `=`.
 *
 * Derived by dropping the trailing `=` from the token's own spelling: the
 * operator set is the language's, and enumerating it by hand here would be a
 * second list to keep in step with the first.
 */
const compoundBaseOperator = (kind: ts.SyntaxKind): string | null => {
  if (kind === ts.SyntaxKind.EqualsToken) return null
  const text = ts.tokenToString(kind)
  return text && text.length > 1 && text.endsWith('=') ? text.slice(0, -1) : null
}

/**
 * The write a compound or plain assignment to a *name* performs.
 *
 * A property target is not handled here: the property family owns that node and
 * publishes the `[[Set]]` itself. Publishing a second write from this side
 * would give one store two authorities.
 */
const bindingWriteFor = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.BinaryExpression | ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  targetExpression: ts.Expression,
  stored: OperandSource | null = null
): { readonly operation: BindingOperation; readonly edges: readonly SemanticEdge[] } | null => {
  const target = unwrapErased(targetExpression)
  // A namespace-qualified member (`Debug.level = 2`) is a name too -- see
  // `namespace-paths.ts`. The census gave it the `reference` family, so no
  // property family publishes a `[[Set]]` for it: this write is the store.
  const symbol = ts.isIdentifier(target)
    ? context.checker.getSymbolAtLocation(target)
    : ts.isPropertyAccessExpression(target)
      ? (context.namespacePaths.memberSymbolOf(target) ?? undefined)
      : undefined
  if (!symbol) return null
  const declaration = context.identities.symbolDeclarationId(symbol)
  if (!declaration) return null

  const declarationNode = context.identities.declarationOfSymbol(symbol)
  const { mutable, temporalDeadZone } = declarationNode ? bindingKindOf(declarationNode) : { mutable: true, temporalDeadZone: false }
  // The value stored is the one the computation at ordinal 0 published, which is
  // the sum for `x += 1` and the incremented number for both `x++` and `++x`.
  // Its type is the target's, not the enclosing expression's: `x++` evaluates to
  // the *old* value, and taking that type here would spell the write's slot from
  // the wrong side of the increment.
  const type = context.types.typeAt(target)
  // Which value is stored is the caller's to state, because the two shapes
  // genuinely differ. A compound assignment or an update stores what THIS
  // node's computation published -- the sum, the incremented number -- and
  // predicts that result rather than running the producer. A logical
  // assignment stores the right-hand side's OWN value: its computation is the
  // merge of both branches, and storing that would write the left-hand value
  // back on the branch where the language performs no store at all.
  const value: OperandSource = stored ?? {
    kind: 'result',
    result: semanticResultId(operationId(context.identities.nodeIdOf(node), 'computation', 0), 'value')
  }
  const id = mintOperationId(context.ordinals, context.identities.nodeIdOf(node), 'binding')
  return {
    operation: {
      id,
      family: 'binding',
      action: 'write',
      declaration,
      mutable,
      temporalDeadZone,
      ...(context.commonJsBindings.has(declaration)
        ? {
            commonJs: {
              global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
              owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body')
            }
          }
        : {}),
      caller: candidate.caller,
      operands: [operand('value', 0, value, type)],
      results: [mintResult(id, 'value', type)],
      completion: normalCompletion,
      effects: { ...pureEffects, writesMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    },
    // A constant right-hand side (`f ??= 'x'`) publishes no result, so there is
    // no value edge to draw -- the operand carries the literal itself, exactly
    // as a plain `=` with a literal does.
    edges: value.kind === 'result' ? [{ kind: 'value', result: value.result, to: id, role: 'value', ordinal: 0 }] : []
  }
}

const finishComputation = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.Expression,
  form: ComputationOperation['form'],
  operatorText: string,
  operands: readonly SemanticOperand[],
  completion: CompletionBehavior,
  effects: EffectBehavior,
  extraEdges: readonly SemanticEdge[] = []
): CandidateContribution => {
  const operationIdentity = mintOperationId(context.ordinals, candidate.id, 'computation')
  // A plain `=` evaluates to the value assigned -- `AssignmentExpression :
  // LeftHandSideExpression = AssignmentExpression` completes with the RHS
  // value after PutValue -- which is exactly the `value` operand built above.
  // That operand's type already carries the RHS's contextual type (`typeAt`
  // special-cases an array/object literal onto its contextual type), while
  // asking the checker about the assignment node itself does not: `this.items
  // = []` reports the literal's own fresh type, `never[]`, not the field's
  // element type. Citing the operand here instead of re-deriving the answer
  // is what keeps the two from disagreeing.
  const resultType = ((): (typeof operands)[number]['type'] => {
    if (form === 'conditional') {
      // `ConditionalExpression` evaluates to one of the two branch values
      // themselves. Its physical result therefore comes from the branch
      // operands this operation already cites, including any contextual
      // layout each literal acquired. Asking the checker for the enclosing
      // expression independently can describe a different, pre-contextual
      // pair: BSON's `const root: Document = flag ? [] : {}` reports
      // `never[] | {}` for the expression while each branch is contextually
      // `Document`, and the array branch's value-flow census further proves
      // an array of dynamic elements. Building the merge from the stale
      // expression type asks those actual values to convert into empty
      // literal carriers, reversing the flow.
      //
      // A union of the two cited branch types is exact: only one branch runs,
      // and `deriveUnion` still collapses arms that share a carrier or have a
      // sound widening. This changes no control-flow fact and invents no
      // type; it stops a second checker query from disagreeing with the
      // operation's own operands.
      const branches = operands.filter((candidate) => candidate.role === 'consequent' || candidate.role === 'alternate')
      const first = branches[0]
      const second = branches[1]
      if (!first || !second) throw new Error('a conditional computation must carry consequent and alternate operands')
      return first.type === second.type ? first.type : context.table.intern({ kind: 'union', members: [first.type, second.type] })
    }
    if (
      form === 'binary' &&
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorKind(node.operatorToken.kind) &&
      compoundBaseOperator(node.operatorToken.kind) !== null
    ) {
      // A compound assignment publishes the value it writes back into its
      // target.  The target operand is already the flow-narrowed type under
      // which TypeScript admitted the operator, and `bindingWriteFor` uses the
      // same type for the store.  The checker's type for the enclosing JS
      // expression can remain `any` even when parameter census proved the
      // target numeric (Three's `hue2rgb`: `t += 1`); publishing that stale
      // outer answer makes the binding write unbox an expression the numeric
      // emitter has already produced as `double`.
      const target = operands[0]
      if (!target) throw new Error('a compound assignment computation must carry its target operand')
      return target.type
    }
    if (form === 'logical' && ts.isBinaryExpression(node) && (operatorText === '||' || operatorText === '??')) {
      // The same rule as the conditional above, for the other merge: `a ?? b`
      // and `a || b` evaluate to the LEFT value when it is kept and the RIGHT
      // value otherwise, so the merge holds the union of the two cited
      // operand types -- the left one less the absences the operator
      // discards, which is `getNonNullableType`, the checker's own
      // half of `a ?? b`'s rule. Applied only where the right operand's
      // cited type is not the checker's own for that node: an operand this
      // compiler re-typed (`links.serialized ??= new Map()`, where the
      // allocation is `Map<any, any>` to the checker and `Map<string,
      // number>` to `typeAt`) is exactly the one the checker's expression
      // type absorbed -- `Map<string, number> | Map<any, any>` subtype-
      // reduces to `Map<any, any>` -- so the expression type describes a
      // value nobody publishes. Elsewhere the checker's answer stands: its
      // `||` also drops falsy LITERALS from the left arm, a narrowing this
      // union would not reproduce, and no operand disagrees with it there.
      const right = operands.find((candidate) => candidate.role === 'right')
      if (right && right.type !== context.types.typeOf(context.checker.getTypeAtLocation(node.right))) {
        const kept = context.types.typeOf(context.checker.getNonNullableType(context.checker.getTypeAtLocation(node.left)))
        return kept === right.type ? kept : context.table.intern({ kind: 'union', members: [kept, right.type] })
      }
    }
    if (form === 'logical' && ts.isBinaryExpression(node) && operatorText === '&&') {
      // `&&` is the same merge as `||` and `??` above and was the one this
      // rule did not cover, so its result alone kept coming from a second
      // checker query at the whole expression -- which is exactly the query
      // that cannot see what the operand censuses proved.
      //
      // Measured on the three.js app: `WebGLPrograms.js`'s `fogExp2: ( !! fog &&
      // fog.isFogExp2 )`. `fog` is `?(Fog|FogExp2)` and `isFogExp2` is
      // declared on only ONE arm, so the checker types the property read
      // `any` (a missing member on a union is an error type, silent in JS)
      // and therefore types the whole `&&` `any`. The member census does NOT
      // agree: it publishes the read as `optional`, having proved the absent
      // arm. The operation's own right operand thus cites `optional` while
      // its result cited `dynamic` -- one expression, two authorities -- and
      // the `dynamic` propagated into the 130-field `parameters` record that
      // every program build copies.
      //
      // The kept half of the left operand is the FALSY arms, not
      // `getNonNullableType`: `&&` discards the truthy ones. Where there are
      // none -- an object-typed guard, `obj && obj.x` -- the expression IS
      // the right operand, and saying so is what keeps a class carrier from
      // being unioned into a numeric answer.
      const right = operands.find((candidate) => candidate.role === 'right')
      if (right && right.type !== context.types.typeOf(context.checker.getTypeAtLocation(node.right))) {
        const keptType = keptLeftPartTypeOf(context.checker, '&&', context.checker.getTypeAtLocation(node.left))
        // An `any`/`unknown` guard keeps an arm that states nothing, and a
        // union built on it states nothing either -- `inferred-logical-result`
        // (`/** @param {*} value */ value && value.isMarker`) is the measured
        // case: this rule fired because the right operand was re-typed, and
        // unioned `dynamic` against it, producing a carrier no producer
        // publishes and losing the program's emission entirely. The rule
        // exists to stop a STALE expression type from overriding PROVEN
        // operand carriers; where the kept half is itself unproven there is
        // nothing to prove with, and the checker's own answer for the
        // expression -- equally unproven, but the one every consumer already
        // agrees on -- stands.
        if (keptType !== null && (keptType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
          const kept = context.types.typeOf(keptType)
          return kept === right.type ? kept : context.table.intern({ kind: 'union', members: [kept, right.type] })
        }
        // No falsy arm at all -- an object-typed guard -- means the expression
        // IS the right operand, which is exact and needs no union.
        if (keptType === null) return right.type
      }
    }
    if (form !== 'assignment') return context.types.typeAt(node)
    const value = operands[0]
    // The plain-assignment call site always builds exactly one operand, the
    // value assigned -- this is an internal invariant of this file, not a
    // fact about source, so a violation is a producer bug to surface loudly
    // rather than a case to paper over with a fallback answer.
    if (!value) throw new Error('a plain assignment computation must carry the value operand it assigns as operand 0')
    return value.type
  })()
  const operation: ComputationOperation = {
    id: operationIdentity,
    family: 'computation',
    caller: candidate.caller,
    form,
    operator: operatorText,
    operands,
    results: [mintResult(operationIdentity, 'value', resultType)],
    completion,
    effects,
    // Evaluation position comes from the shared per-caller counter, never
    // from a source offset: the two are not comparable, so an operation
    // ordinalled by offset sorts before every operation ordinalled by count
    // regardless of the order either actually runs in.
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [...valueEdgesInto(operationIdentity, operands), ...extraEdges] }
}

/** Coercions that can invoke user-defined `valueOf`/`toString`/`Symbol.toPrimitive` can throw. */
const coercingEffects: EffectBehavior = { readsMutableState: false, writesMutableState: false, allocates: false, callsUserCode: true }

const contributeLogical = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.BinaryExpression,
  kind: ts.SyntaxKind
): CandidateContribution => {
  const leftSource = sourceForValue(context, node.left)
  if (leftSource.kind !== 'result') {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'computation',
        'a logical short-circuit guard needs a producible left-hand result; a constant, this, or super guard is not modelled',
        'P0'
      )
    }
  }
  const takenWhen: 'truthy' | 'falsy' | 'nullish' =
    kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'truthy' : kind === ts.SyntaxKind.BarBarToken ? 'falsy' : 'nullish'

  const left = operand('left', 0, leftSource, context.types.typeAt(node.left))
  const right = operand('right', 0, sourceForValue(context, node.right), context.types.typeAt(node.right), {
    kind: 'conditional',
    guard: leftSource.result,
    takenWhen
  })

  // No conditional edge is published here: gating a whole subtree is what the
  // normalization gating pass does, and two producers of the same relation
  // would order one operation's scope chain two ways.
  return finishComputation(context, candidate, node, 'logical', tokenText(kind), [left, right], normalCompletion, pureEffects)
}

/**
 * `a &&= b` / `a ||= b` / `a ??= b` -- ECMA-262 13.15.2.
 *
 * Not a read-operate-write, and decomposing it as one would be wrong: the
 * language performs NO store at all on the short-circuiting branch, so a
 * lowering that always wrote would write a value the source leaves untouched
 * (`shared.ts`'s `logicalAssignmentOperators` says exactly this, which is why
 * `isCompoundAssignmentOperator` excludes these three).
 *
 * What it IS, is the plain logical operator plus a conditional store. So it is
 * published as exactly that pair, and nothing new is invented for it:
 *
 *  - the value of `a ||= b` is the value of `a || b` -- the left-hand value on
 *    the short-circuiting branch, the right-hand one otherwise -- so the
 *    computation is `contributeLogical`'s own `'logical'` form under the base
 *    operator, with the right operand conditional on the same guard;
 *  - the store happens only on the branch that evaluates the right-hand side,
 *    and stores THAT value, not the merge. Storing the merge would write the
 *    left-hand value back over itself on the other branch -- an observable
 *    difference through a setter, and a spurious mutation of a `const`-like
 *    cell either way.
 *
 * Placing the store on the right branch is `normalize/gating.ts`'s job, not
 * this producer's: an `OperandEvaluation` says an OPERAND is conditionally
 * evaluated, while which block an OPERATION lands in is decided by the gate
 * walk, from syntax. This states the operand condition; `gating.ts`'s own
 * logical-assignment case gates the `binding` operation to match. The two
 * halves are separate on purpose -- the same split `a?.b()`'s argument
 * subtree needed.
 *
 * Only an identifier target is served here. `bindingWriteFor` returns `null`
 * for anything else, and a property target (`obj.x ??= v`) is the property
 * family's own get-then-set shape rather than this one -- it refuses by name
 * in `producers/properties.ts` until that half is written.
 */
const contributeLogicalAssignment = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.BinaryExpression,
  kind: ts.SyntaxKind
): CandidateContribution => {
  const leftSource = sourceForValue(context, node.left)
  if (leftSource.kind !== 'result') {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'computation',
        "a logical assignment short-circuits on its target's own value, and this target publishes no citable result",
        'P0'
      )
    }
  }
  const takenWhen: 'truthy' | 'falsy' | 'nullish' =
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ? 'truthy' : kind === ts.SyntaxKind.BarBarEqualsToken ? 'falsy' : 'nullish'
  const rightSource = sourceForValue(context, node.right)
  const left = operand('left', 0, leftSource, context.types.typeAt(node.left))
  const right = operand('right', 0, rightSource, context.types.typeAt(node.right), {
    kind: 'conditional',
    guard: leftSource.result,
    takenWhen
  })
  // The base operator, deliberately: the emitted merge is `a || b`'s, and
  // spelling it `||=` here would name an operator the computation families
  // downstream have no case for.
  const operatorText = tokenText(
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      ? ts.SyntaxKind.AmpersandAmpersandToken
      : kind === ts.SyntaxKind.BarBarEqualsToken
        ? ts.SyntaxKind.BarBarToken
        : ts.SyntaxKind.QuestionQuestionToken
  )
  const computed = finishComputation(context, candidate, node, 'logical', operatorText, [left, right], throwingCompletion, {
    readsMutableState: true,
    writesMutableState: true,
    allocates: false,
    callsUserCode: true
  })
  if (computed.kind !== 'operations') return computed
  const write = bindingWriteFor(context, candidate, node, node.left, rightSource)
  // A property target publishes no binding write at all: the property family
  // owns that store and publishes it -- gated the same way -- from its own
  // `logical-set` intent. Exactly the division a plain `=` already has.
  if (!write) return computed
  return {
    kind: 'operations',
    operations: [...computed.operations, write.operation],
    edges: [
      ...computed.edges,
      ...write.edges,
      // The store happens only on the branch the operator does not
      // short-circuit on. Stated as an edge, because an edge is what places an
      // OPERATION; `normalize/gating.ts` places the right-hand subtree.
      { kind: 'conditional', guard: leftSource.result, to: write.operation.id, takenWhen }
    ]
  }
}

const contributeConditional = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.ConditionalExpression
): CandidateContribution => {
  const conditionSource = sourceForValue(context, node.condition)
  if (conditionSource.kind !== 'result') {
    return {
      kind: 'blocked',
      blocker: blocked(
        candidate.id,
        'computation',
        'a conditional expression needs a producible condition result to gate its branches; a constant, this, or super condition is not modelled',
        'P0'
      )
    }
  }
  const condition = operand('condition', 0, conditionSource, context.types.typeAt(node.condition))
  const branchValueTypeAt = (branch: ts.Expression) =>
    ts.isPropertyAccessExpression(branch) || ts.isElementAccessExpression(branch)
      ? propertyExpressionValueTypeAt(context, branch)
      : context.types.typeAt(branch)
  const consequent = operand('consequent', 0, sourceForValue(context, node.whenTrue), branchValueTypeAt(node.whenTrue), {
    kind: 'conditional',
    guard: conditionSource.result,
    takenWhen: 'truthy'
  })
  const alternate = operand('alternate', 0, sourceForValue(context, node.whenFalse), branchValueTypeAt(node.whenFalse), {
    kind: 'conditional',
    guard: conditionSource.result,
    takenWhen: 'falsy'
  })

  return finishComputation(context, candidate, node, 'conditional', '?:', [condition, consequent, alternate], normalCompletion, pureEffects)
}

const contributeTemplate = (context: ProducerContext, candidate: CensusCandidate, node: ts.TemplateExpression): CandidateContribution => {
  // The literal text between the substitutions is part of the value, so it is
  // carried as operands rather than left on the syntax node: an IR that has to
  // reach back to the AST to know what a template concatenates is an IR that
  // does not state the computation. They are interleaved in the order the
  // language concatenates them -- head, substitution 0, the text after it, ...
  // -- so the consumer folds the operand list and never has to re-derive the
  // arrangement. An empty chunk is dropped: it contributes nothing, and
  // `` `${a}${b}` `` is full of them.
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const operands: SemanticOperand[] = []
  const chunk = (text: string, index: number): void => {
    if (text.length === 0) return
    operands.push(operand('chunk', index, { kind: 'constant', text, literal: 'string' }, stringType))
  }
  chunk(node.head.text, 0)
  node.templateSpans.forEach((span, index) => {
    operands.push(operand('substitution', index, sourceForValue(context, span.expression), context.types.typeAt(span.expression)))
    chunk(span.literal.text, index + 1)
  })
  // Each substitution goes through ToString, which can invoke a user-defined
  // `toString`/`Symbol.toPrimitive`, or throw outright for a `symbol`.
  return finishComputation(context, candidate, node, 'template', 'template', operands, throwingCompletion, coercingEffects)
}

/** `typeof`/`void`/`delete`: a single operand, form and throwability keyed by the operator keyword. */
const contributeKeywordUnary = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.Expression,
  operandExpr: ts.Expression,
  form: ComputationOperation['form'],
  operatorText: 'typeof' | 'void' | 'delete'
): CandidateContribution => {
  const value = operand('operand', 0, sourceForValue(context, operandExpr), context.types.typeAt(operandExpr))
  if (operatorText === 'typeof' || operatorText === 'void') {
    // `typeof` never throws (every reference it inspects is checker-resolved,
    // so the unresolvable-reference exemption never has to fire), and `void`
    // only evaluates and discards.
    return finishComputation(context, candidate, node, form, operatorText, [value], normalCompletion, pureEffects)
  }
  // `delete` can throw in strict-mode code (all TypeScript/ESM code is
  // strict) when the target is a non-configurable own property, and a Proxy
  // `deleteProperty` trap can run arbitrary code.
  return finishComputation(context, candidate, node, form, operatorText, [value], throwingCompletion, {
    readsMutableState: false,
    writesMutableState: true,
    allocates: false,
    callsUserCode: true
  })
}

/**
 * `++` and `--`, decomposed the way the language defines them.
 *
 * The language performs three steps: read the target, coerce the old value with
 * ToNumeric, and store old +/- 1. A prefix form evaluates to the stored value; a
 * postfix form evaluates to the *old* one, which is why the coercion is a
 * published operation of its own rather than something folded into the update.
 * Nothing here re-reads the target: the read is whatever the target's own family
 * published -- a name's GetValue, a property's [[Get]] -- exactly as a compound
 * assignment cites it, so both sides of `o.p++` see one read.
 *
 * The increment is minted first, at ordinal 0, because ordinal 0 is the identity
 * every writer already cites as "the value stored": `bindingWriteFor` here and
 * the property family's `get-then-set` both predict it without running this
 * producer. The postfix coercion therefore lands at ordinal 1, and
 * `citeExpressionResult` predicts that same ordinal for a postfix consumer.
 */
const contributeUpdate = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression
): CandidateContribution => {
  const postfix = ts.isPostfixUnaryExpression(node)
  const targetSource = sourceForValue(context, node.operand)
  const oldType = context.types.typeAt(node.operand)
  const storedType = postfix ? oldType : context.types.typeAt(node)

  const updateId = mintOperationId(context.ordinals, candidate.id, 'computation')
  const coercionId = postfix ? mintOperationId(context.ordinals, candidate.id, 'computation') : null

  // ToNumeric can run a user-defined `valueOf`, so the increment reads a value
  // an arbitrary call produced. A prefix form has no separate coercion to cite
  // and folds it into the update, exactly as `x += 1` folds it into the `+`.
  const incrementOperand = coercionId
    ? operand('operand', 0, { kind: 'result', result: semanticResultId(coercionId, 'value') }, oldType)
    : operand('operand', 0, targetSource, oldType)

  const update: ComputationOperation = {
    id: updateId,
    family: 'computation',
    caller: candidate.caller,
    form: 'update',
    operator: tokenText(node.operator),
    operands: [incrementOperand],
    results: [mintResult(updateId, 'value', storedType)],
    completion: throwingCompletion,
    effects: coercingEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  const operations: ComputationOperation[] = [update]
  const edges: SemanticEdge[] = [...valueEdgesInto(updateId, update.operands)]
  if (coercionId) {
    const coercion: ComputationOperation = {
      id: coercionId,
      family: 'computation',
      caller: candidate.caller,
      form: 'coercion',
      operator: 'ToNumeric',
      operands: [operand('operand', 0, targetSource, oldType)],
      results: [mintResult(coercionId, 'value', context.types.typeAt(node))],
      completion: throwingCompletion,
      effects: coercingEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    operations.push(coercion)
    edges.push(...valueEdgesInto(coercionId, coercion.operands))
  }

  const write = bindingWriteFor(context, candidate, node, node.operand)
  if (!write) return { kind: 'operations', operations, edges }
  return { kind: 'operations', operations: [...operations, write.operation], edges: [...edges, ...write.edges] }
}

const contributeUnaryOrUpdate = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression
): CandidateContribution => {
  if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
    return contributeUpdate(context, candidate, node)
  }
  // Only `PrefixUnaryExpression` reaches here: a `PostfixUnaryExpression`'s
  // operator is always `++`/`--`, handled above.
  const prefix = node as ts.PrefixUnaryExpression
  const operatorText = tokenText(prefix.operator)
  const value = operand('operand', 0, sourceForValue(context, prefix.operand), context.types.typeAt(prefix.operand))
  if (prefix.operator === ts.SyntaxKind.ExclamationToken) {
    // `!` performs ToBoolean, which never invokes user code and never throws.
    return finishComputation(context, candidate, prefix, 'unary', operatorText, [value], normalCompletion, pureEffects)
  }
  // `+`, `-`, `~`: ToNumeric coercion can invoke a user-defined `valueOf`.
  return finishComputation(context, candidate, prefix, 'unary', operatorText, [value], throwingCompletion, coercingEffects)
}

const contributeBinary = (context: ProducerContext, candidate: CensusCandidate, node: ts.BinaryExpression): CandidateContribution => {
  const kind = node.operatorToken.kind

  if (kind === ts.SyntaxKind.CommaToken) {
    const left = operand('left', 0, sourceForValue(context, node.left), context.types.typeAt(node.left))
    const right = operand('right', 0, sourceForValue(context, node.right), context.types.typeAt(node.right))
    // The comma operator itself never throws; either operand's own operation
    // carries whatever completion evaluating it can produce.
    return finishComputation(context, candidate, node, 'comma', tokenText(kind), [left, right], normalCompletion, pureEffects)
  }

  if (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return contributeLogical(context, candidate, node, kind)
  }

  if (isAssignmentOperatorKind(kind)) {
    if (logicalAssignmentOperators.has(kind)) return contributeLogicalAssignment(context, candidate, node, kind)

    const compound = compoundBaseOperator(kind)
    // A compound assignment is a read, an operation, and a write -- the same
    // three the language performs, published as the three operations they are.
    // The read is not invented here: the target's own family already publishes
    // it (a name's GetValue, a property's [[Get]]), and this cites it, so the
    // value combined is the same one any other consumer of that target sees.
    const assignedObjectTarget = compound === null ? objectAssignTargetType(context.checker, node.right) : null
    const createdObjectTarget =
      compound === null && assignedObjectTarget === null && ts.isCallExpression(node.right)
        ? objectCreateResultOverride(context, node.right, unwrapErased(node.right.expression))
        : null
    const operands = compound
      ? [
          operand('left', 0, sourceForValue(context, node.left), context.types.typeAt(node.left)),
          operand('right', 0, sourceForValue(context, node.right), context.types.typeAt(node.right))
        ]
      : // Plain `=` never reads the target's old value: it evaluates the target
        // as a Reference and the right-hand side as a value, then performs
        // PutValue. This operation carries the value; the write is published
        // below, or by the property family when the target is a property.
        [
          operand(
            'value',
            0,
            sourceForValue(context, node.right),
            assignedObjectTarget !== null
              ? context.types.typeOf(assignedObjectTarget)
              : (createdObjectTarget ?? context.types.typeAt(node.right))
          )
        ]

    const computed = finishComputation(
      context,
      candidate,
      node,
      compound ? 'binary' : 'assignment',
      compound ?? tokenText(kind),
      operands,
      throwingCompletion,
      { readsMutableState: compound !== null, writesMutableState: true, allocates: false, callsUserCode: true }
    )
    if (computed.kind !== 'operations') return computed
    const write = bindingWriteFor(context, candidate, node, node.left)
    if (!write) return computed
    return { kind: 'operations', operations: [...computed.operations, write.operation], edges: [...computed.edges, ...write.edges] }
  }

  // `k in o` for a `unique symbol` binding that names one of `o`'s own
  // DECLARED members is compile-time-known exactly as `o[k]` is
  // (`properties.ts`'s `keyOf`/`symbolMemberKeyOf`, whose doc comment states
  // the same distinction): the left operand is the member's static text, not
  // a runtime symbol value, so the census-level `in` obligation
  // (`ir/certify/property-access.ts`'s `hasPropertyRuntimeHelperKey`) can
  // prove presence/absence from the declared field's own presence bit
  // instead of falling to "record(unproven)". A symbol that is NOT a
  // declared member of `o` (an expando the program tests for, `cacheKey in
  // res`) is left exactly as before -- `symbolMemberKeyOf` answers `null` for
  // it, same as it does for `properties.ts`.
  const inKeyType = kind === ts.SyntaxKind.InKeyword ? context.types.typeAt(node.left) : null
  const inSymbolKey = inKeyType !== null ? symbolMemberKeyOf(context, node.right, inKeyType) : null
  const left =
    inSymbolKey !== null
      ? operand('left', 0, { kind: 'constant', text: inSymbolKey, literal: 'string' }, inKeyType!)
      : operand('left', 0, sourceForValue(context, node.left), context.types.typeAt(node.left))
  const right = operand('right', 0, sourceForValue(context, node.right), context.types.typeAt(node.right))

  if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    // Strict (in)equality is `SameValueZero`-like: it never coerces and never
    // invokes user code, so it is the one binary form that provably cannot throw.
    return finishComputation(context, candidate, node, 'equality', tokenText(kind), [left, right], normalCompletion, pureEffects)
  }
  if (kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
    // Loose (in)equality can invoke `ToPrimitive` on an object operand.
    return finishComputation(context, candidate, node, 'equality', tokenText(kind), [left, right], throwingCompletion, coercingEffects)
  }
  if (kind === ts.SyntaxKind.InstanceOfKeyword) {
    // Can invoke a user-defined `Symbol.hasInstance`, or throw if the
    // right-hand side is not callable.
    return finishComputation(context, candidate, node, 'instanceof', tokenText(kind), [left, right], throwingCompletion, coercingEffects)
  }
  if (kind === ts.SyntaxKind.InKeyword) {
    // Throws if the right-hand side is not an object; a Proxy `has` trap can
    // run arbitrary code.
    return finishComputation(context, candidate, node, 'in', tokenText(kind), [left, right], throwingCompletion, coercingEffects)
  }

  // Arithmetic, bitwise, shift, and relational operators: `ToNumeric`/
  // `ToPrimitive` coercion can invoke a user-defined `valueOf`/`toString`, or
  // throw on a `BigInt`/`Number` mix.
  return finishComputation(context, candidate, node, 'binary', tokenText(kind), [left, right], throwingCompletion, coercingEffects)
}

export const createComputationProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'computation',
  contribute: (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node as ComputationNode

    if (ts.isBinaryExpression(node)) return contributeBinary(context, candidate, node)
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return contributeUnaryOrUpdate(context, candidate, node)
    if (ts.isConditionalExpression(node)) return contributeConditional(context, candidate, node)
    if (ts.isTemplateExpression(node)) return contributeTemplate(context, candidate, node)
    if (ts.isTypeOfExpression(node)) return contributeKeywordUnary(context, candidate, node, node.expression, 'typeof', 'typeof')
    if (ts.isVoidExpression(node)) return contributeKeywordUnary(context, candidate, node, node.expression, 'unary', 'void')
    // The only remaining census member is `DeleteExpression`.
    return contributeKeywordUnary(context, candidate, node, node.expression, 'unary', 'delete')
  }
})
