import ts from 'typescript'
import { isUnusableEvidence } from '../derived-expression-type.js'
import {
  arrayAssignmentSource,
  arrayAssignmentTargetOf,
  arrayAssignmentWriteTargetOf,
  isObjectAssignmentElement,
  type ArrayAssignmentTarget
} from '../assignment-patterns.js'
import { contributeObjectAssignmentElement, contributeObjectAssignmentSource } from './object-assignment.js'
import type { OperationId, SemanticResultId, StructuralTypeId } from '../../../identity/ids.js'
import { operationId, regionId, semanticResultId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import type { BindingOperation, DestructuringOperation, PropertyOperation, ProtocolOperation } from '../../model/operations.js'
import type { CompletionBehavior, EffectBehavior, OperandSource, SemanticCaller, SemanticOperand } from '../../model/operands.js'
import { normalCompletion, throwingCompletion } from '../../model/operands.js'
import type { CensusCandidate } from '../census.js'
import type { IdentityTable } from '../identities.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import {
  asBlocked,
  hasNativeIterationCursor,
  isFixedArityTupleType,
  isGeneratorType,
  isStrictContext,
  resultEdge,
  unwrapErased,
  valueEdgesInto
} from './shared.js'
import { citeExpressionResult } from './references.js'
import { memberTypeOf } from '../derived-expression-type.js'
import { bindingKindOf } from './binding-kind.js'
import { iteratorYieldStructuralType, iteratorYieldTypesOf } from './iteration-yield.js'
import { isDynamicIterationSource, mintIteratorSteps } from './protocol.js'

/**
 * The result carrying the value a binding element finally receives.
 *
 * The binding family introduces the name, this family extracts the value, and
 * neither may guess at the other's work -- so the two meet the way every other
 * cross-family citation does: by recomputing the identity the other side
 * independently mints. That recomputation is only sound because each element's
 * operations are keyed on the *element's* own node, and because the ordinal is
 * fixed by a property of the element rather than by its position in the walk: a
 * defaulted element publishes its extraction first and its `default-value`
 * second, and the second is the one the name is bound to.
 */
export const citeBoundElementValue = (element: ts.BindingElement, identities: IdentityTable): OperandSource => ({
  kind: 'result',
  result: semanticResultId(operationId(identities.nodeIdOf(element), 'destructuring', element.initializer ? 1 : 0), 'value')
})

/**
 * The EXTRACTION's result for a binding element -- always ordinal 0, whether or
 * not the element is defaulted.
 *
 * `citeBoundElementValue` answers "what is the name bound to", which for a
 * defaulted element is the `default-value` step. This answers "what did the
 * pattern actually read out of the source", which is what that step tests for
 * absence and what `gating.ts` names as the guard over the initializer. Two
 * questions, two ordinals, recomputed the same way rather than looked up.
 */
export const citeExtractedElementValue = (element: ts.BindingElement, identities: IdentityTable): SemanticResultId =>
  semanticResultId(operationId(identities.nodeIdOf(element), 'destructuring', 0), 'value')

type KeyResolution = { readonly source: OperandSource; readonly type: StructuralTypeId } | { readonly blocked: string }
type PatternSource = {
  readonly source: OperandSource
  readonly type: StructuralTypeId
  /** Checker-level source evidence used to resolve a typed custom @@iterator without retyping target syntax. */
  readonly rawType: ts.Type
  readonly at: ts.Node
}

/**
 * The type an object rest element and the binding it initializes must share.
 *
 * TypeScript narrows `Document` through a predicate such as `value is
 * DBRefLike` and then types `{ known, ...rest }` as a closed `{}` when every
 * named member of the predicate was excluded. That answer loses the index
 * signature the runtime object still has: CopyDataProperties must retain all
 * of the source's other keys. A binding read physically cites its declaration's
 * published cell, so recover that storage type and preserve it when it is a
 * members-free string dictionary. Both producer families call this function;
 * otherwise the extraction would publish a dictionary and the introduced name
 * would immediately demand a dictionary-to-empty-record conversion.
 */
export const boundElementType = (element: ts.BindingElement, context: ProducerContext): StructuralTypeId => {
  const checkerType = context.types.typeAt(element)
  if (!element.dotDotDotToken || !ts.isObjectBindingPattern(element.parent)) return checkerType

  const isOpenStringDictionary = (id: StructuralTypeId, seen = new Set<StructuralTypeId>()): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    const shape = context.table.get(id).shape
    if (shape.kind === 'declared' && shape.body) return isOpenStringDictionary(shape.body, seen)
    if (shape.kind === 'intersection' && shape.resolved) return isOpenStringDictionary(shape.resolved, seen)
    return shape.kind === 'object' && shape.members.length === 0 && shape.index.some((index) => index.key === 'string')
  }

  const pattern = element.parent
  const parent = pattern.parent
  let storageType = context.types.typeAt(pattern)
  if (ts.isParameter(parent) && parent.name === pattern) storageType = context.types.typeAt(parent)
  else if (ts.isBindingElement(parent) && parent.name === pattern) storageType = context.types.typeAt(parent)
  else if (ts.isVariableDeclaration(parent) && parent.name === pattern && parent.initializer) {
    const source = unwrapErased(parent.initializer)
    if (ts.isIdentifier(source)) {
      let symbol = context.checker.getSymbolAtLocation(source)
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = context.checker.getAliasedSymbol(symbol)
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
      if (declaration) storageType = context.types.typeAt(declaration)
    }
  }
  return isOpenStringDictionary(storageType) ? storageType : checkerType
}

export const createDestructuringProducer = (context: ProducerContext): FamilyProducer => {
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })

  /**
   * A property key from a binding element, static or computed.
   *
   * A computed key's value comes from whichever family normalized the
   * bracketed expression (`citeExpressionResult`); it is `blocked` only when
   * that expression itself has no censused family, never merely for being
   * computed. Everything downstream treats the key as an ordinary operand, so
   * a computed key can still take its place among a rest element's excluded
   * keys -- as a cited value instead of a constant, not as a reason to refuse.
   */
  const keyResolutionOf = (element: ts.BindingElement): KeyResolution => {
    const name = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined)
    if (!name) return { blocked: 'binding element has neither a property name nor an identifier target' }
    if (ts.isIdentifier(name)) return { source: { kind: 'constant', text: name.text, literal: 'string' }, type: stringType }
    // A numeric/string/bigint/no-substitution-template property name is still a
    // statically known `ToPropertyKey` result -- reading its literal text here
    // is reading the language-defined VALUE the key has, not source spelling
    // used as identity.
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isBigIntLiteral(name)) {
      return { source: { kind: 'constant', text: name.text, literal: 'string' }, type: stringType }
    }
    if (!ts.isComputedPropertyName(name)) {
      return { blocked: 'private-identifier property name has no property-key value to bind against' }
    }
    const cited = citeExpressionResult(name.expression, context)
    if (cited.kind === 'unmodelled') return { blocked: cited.reason }
    return { source: cited.source, type: context.types.typeAt(name.expression) }
  }

  const buildOperation = (
    id: OperationId,
    caller: SemanticCaller,
    evaluationOrdinal: number,
    form: DestructuringOperation['form'],
    operands: readonly SemanticOperand[],
    resultType: StructuralTypeId | null,
    completion: CompletionBehavior,
    effects: EffectBehavior
  ): DestructuringOperation => ({
    id,
    caller,
    operands,
    results: resultType ? [mintResult(id, 'value', resultType)] : [],
    completion,
    effects,
    evaluationOrdinal,
    family: 'destructuring',
    form
  })

  const finitePatternNeedsClose = (type: StructuralTypeId): boolean =>
    isDynamicIterationSource(context, type) || isGeneratorType(context, type) || !hasNativeIterationCursor(context, type)

  /**
   * This pattern's own source value, as an operand source -- either the
   * result a sibling element of an *outer* pattern already publishes (the
   * nested case, `{a: {b}}`/`[[x]]`/`[...[a,b]]`), or the initializer of the
   * `const`/`let`/`var` declaration this pattern names directly (the
   * top-level case), or the frame slot a formal parameter binds. A catch
   * binding still has no source here: the value comes from a thrown
   * exception rather than from any operation this producer can cite, so it
   * is correctly `null` rather than guessed at.
   *
   * The nested case is answered by RECOMPUTING the sibling element's
   * extraction identity (`citeBoundElementValue`, exported above for the
   * *binding* family's own identical cross-family citation) rather than by
   * looking one up in a table this producer populated itself. A lookup table
   * keyed by the enclosing candidate's own contribute() call would need that
   * candidate contributed *first* -- but `census.ts`'s own walk is
   * documented and built the other way round ("Children first, then this
   * node: the ordinal is an *evaluation* index, and an expression's operands
   * evaluate before the expression does"), so a NESTED pattern's candidate is
   * always contributed *before* the pattern enclosing it, and a table
   * populated by the enclosing candidate is provably still empty every time
   * this asks it. `citeExtractedElementValue`/`citeBoundElementValue`
   * already avoid this exact trap for the *other* cross-family citation in
   * this file by recomputing a deterministic identity instead of reading
   * one back from a map an ordering assumption would have to hold for --
   * this is that same fix, applied to the citation this producer makes of
   * itself.
   */
  const patternSourceOperand = (pattern: ts.BindingPattern): PatternSource | null => {
    const parent = pattern.parent
    if (ts.isBindingElement(parent) && parent.name === pattern) {
      return {
        source: citeBoundElementValue(parent, context.identities),
        type: boundElementType(parent, context),
        rawType: context.types.rawTypeAt(pattern),
        at: pattern
      }
    }
    if (ts.isVariableDeclaration(parent) && parent.name === pattern && parent.initializer) {
      const cited = citeExpressionResult(parent.initializer, context)
      return cited.kind === 'source'
        ? {
            source: cited.source,
            // The PATTERN's own published type, not the initializer's asked a
            // second time. `citeExpressionResult` above cites the ERASED
            // initializer's result (`as`/`!`/`satisfies` evaluate to nothing of
            // their own), and `structural.ts`'s `binding-pattern-is-its-source`
            // is the one place that decides which of the two an assertion
            // leaves the pattern reading. Asking the initializer here made this
            // the second authority on that, and the value cited and the type
            // declared for it then described different values.
            type: context.types.typeAt(pattern),
            rawType: context.types.rawTypeAt(parent.initializer),
            at: parent.initializer
          }
        : null
    }
    // `function f({a, b})` holds the argument in the parameter's own cell while
    // the pattern reads it, and the binding producer publishes exactly that
    // cell's `initialize`. Citing it by predicted identity is the same
    // agreement every other cross-family citation is built on.
    if (ts.isParameter(parent) && parent.name === pattern) {
      const id = operationId(context.identities.nodeIdOf(parent), 'binding', 0)
      return {
        source: { kind: 'result', result: semanticResultId(id, 'value') },
        type: context.types.typeAt(parent),
        rawType: context.types.rawTypeAt(parent),
        at: parent
      }
    }
    // `for (const [k, v] of pairs)`: a loop variable that is a PATTERN has no
    // `=` initializer any more than `for (const x of xs)` does -- ECMA-262
    // assigns it from the loop's own `IteratorStep` at the head of every
    // iteration -- so its source is that step's value, cited by the same fixed
    // ordinal `producers/bindings.ts`'s `forOfLoopVariableNextResult` cites for
    // the identifier case. `mintIteratorSteps` (protocol.ts) reserves `next` at
    // ordinal 2 for exactly this: the citation is the same `SemanticResultId`
    // whether the loop took the native-cursor path or the general protocol, and
    // whether or not this compiler can lower either.
    //
    // Without this the pattern had no source operand at all, so every step of
    // it keyed as "destructuring:array-pattern:absent" -- a key no manifest
    // claims -- and `for (const [k, v] of ...)` was refused with a message
    // about the pattern rather than about the loop it belongs to.
    if (ts.isVariableDeclaration(parent) && parent.name === pattern && !parent.initializer) {
      const list = parent.parent
      const loop = ts.isVariableDeclarationList(list) ? list.parent : null
      if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === list) {
        const id = operationId(context.identities.nodeIdOf(loop), 'protocol', 2)
        const iterable = context.types.typeAt(loop.expression)
        const shape = context.table.get(iterable).shape
        const type = shape.kind === 'array' ? shape.element : context.types.typeAt(pattern)
        return {
          source: { kind: 'result', result: semanticResultId(id, 'value') },
          type,
          rawType: context.types.rawTypeAt(pattern),
          at: pattern
        }
      }
    }
    return null
  }

  /** The `base`/`iterator` operand for a step, wired only when a source value is known. */
  const sourceOperand = (
    role: string,
    known: PatternSource | OperandSource | null,
    type: StructuralTypeId
  ): { readonly operands: readonly SemanticOperand[]; readonly edge: (to: OperationId) => SemanticEdge | null } => {
    if (!known) return { operands: [], edge: () => null }
    const source = 'source' in known ? known.source : known
    return {
      operands: [operand(role, 0, source, type, { kind: 'provenance' })],
      edge: (to) => (source.kind === 'result' ? { kind: 'value', result: source.result, to, role, ordinal: 0 } : null)
    }
  }

  /**
   * A default-value fallback, modelled as its own operation: the requirement
   * that it fire only when the extracted value is exactly `undefined` (never
   * `null`) has no matching `OperandEvaluation.conditional` `takenWhen` --
   * that vocabulary only has `nullish`, which is wrong here -- so the
   * distinction lives in this operation's own identity (`default-value`)
   * rather than being expressed through the shared conditional-edge mechanism.
   */
  const contributeDefault = (
    candidate: CensusCandidate,
    source: ts.Node,
    extracted: SemanticResultId,
    valueType: StructuralTypeId,
    initializer: ts.Expression,
    fallbackType: StructuralTypeId
  ): (DestructuringOperation & { readonly edges: readonly SemanticEdge[] }) | { readonly blocked: string } => {
    const cited = citeExpressionResult(initializer, context)
    if (cited.kind === 'unmodelled') return { blocked: cited.reason }
    const operands: SemanticOperand[] = [
      operand('extracted', 0, { kind: 'result', result: extracted }, valueType, { kind: 'provenance' }),
      operand('fallback', 0, cited.source, fallbackType)
    ]
    const id = mintOperationId(context.ordinals, context.identities.nodeIdOf(source), 'destructuring')
    const op = buildOperation(id, candidate.caller, candidate.evaluationOrdinal, 'default-value', operands, valueType, normalCompletion, {
      readsMutableState: false,
      writesMutableState: false,
      allocates: false,
      callsUserCode: cited.source.kind === 'result'
    })
    const edges: SemanticEdge[] = [{ kind: 'value', result: extracted, to: id, role: 'extracted', ordinal: 0 }]
    const fallbackEdge = resultEdge(cited.source, id, 'fallback', 0)
    if (fallbackEdge) edges.push(fallbackEdge)
    return { ...op, edges }
  }

  /**
   * The type an object pattern READS OUT of its source for one element, which
   * for a defaulted element is not the type the name ends up bound to.
   *
   * `const { width = 10 } = options` over `{ width?: number }` desugars to a
   * `[[Get]]` yielding `number | undefined` followed by a test against
   * `undefined`. `typeAt(element)` answers the SECOND of those -- `number` --
   * because that is what the name is bound to once the default has run, and
   * typing the extraction with it leaves the `default-value` step testing a
   * carrier with no absent state at all. That is not a refusal: `is-defined`
   * over such a carrier is honestly `true` (`emit-presence.ts`), so the default
   * arm becomes dead code and the extraction dereferences an empty optional --
   * a program that aborts where the language answers `10`.
   *
   * So the property's own type is asked of the checker, which is the same
   * question the language answers to type the pattern. An index signature
   * answers for a key no declared member matches (`Record<string, number>`); a
   * computed key, or a base with neither, has no static answer, and the type
   * stays what it was -- the lowering then refuses the step by name, because a
   * guard it cannot test is the one thing it must not approximate.
   */
  const extractedTypeOf = (element: ts.BindingElement, pattern: ts.ObjectBindingPattern): StructuralTypeId => {
    const bound = context.types.typeAt(element)
    // The census's own read first, as `extractedArrayTypeOf` asks it: a
    // numeric key over a plain array reads `T | undefined` whether or not a
    // default follows, and the name's bound type has no arm for the absence.
    const censused = context.types.patternReadTypeAt(element)
    if (censused) return context.types.typeOf(censused)
    if (!element.initializer) return bound
    const name = element.propertyName ?? element.name
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null
    if (key === null) return bound
    // HOLDS: the value this pattern destructures, read the census-aware way
    // (`context.types.rawTypeAt`, the raw-`ts.Type` form of the same answer
    // `context.types.typeAt(node)` already gives `baseType` above) rather
    // than the checker directly, so an untyped source parameter/local the
    // census resolved is not silently re-widened to `any` here.
    const base = context.types.rawTypeAt(pattern)
    // The shared member-read authority (`derived-expression-type.ts`), the
    // same one every other property read in this compiler goes through --
    // rather than a second, narrower copy of `getPropertyOfType` +
    // `getTypeOfSymbolAtLocation` with no `isUnusableEvidence`/overload
    // handling of its own.
    const member = memberTypeOf(context.checker, base, key, element)
    if (member) return context.types.typeOf(member)
    const index = context.checker.getIndexTypeOfType(context.checker.getNonNullableType(base), ts.IndexKind.String)
    return index ? context.types.typeOf(index) : bound
  }

  const contributeObjectPattern = (candidate: CensusCandidate, node: ts.ObjectBindingPattern): CandidateContribution => {
    const elements = node.elements
    const known = patternSourceOperand(node)
    const baseType = known?.type ?? context.types.typeAt(node)
    const operations: DestructuringOperation[] = []
    const edges: SemanticEdge[] = []
    const excludedKeys: SemanticOperand[] = []
    let previousId: OperationId | null = null
    const chain = (id: OperationId): void => {
      if (previousId) edges.push({ kind: 'evaluation', from: previousId, to: id })
      previousId = id
    }
    for (const element of elements) {
      if (element.dotDotDotToken) continue // rest is always last; handled below

      const key = keyResolutionOf(element)
      if ('blocked' in key) {
        // Withholding the whole pattern (rather than the one bad element) keeps
        // a partially-published pattern from letting a consumer read some
        // names but not others with no signal that the set is incomplete.
        return asBlocked(candidate.id, 'destructuring', `object binding pattern key ${key.blocked}`, 'P1')
      }
      excludedKeys.push(operand('excluded-key', excludedKeys.length, key.source, key.type))

      const { operands: baseOperands, edge: baseEdge } = sourceOperand('base', known, baseType)
      const operands: SemanticOperand[] = [operand('key', 0, key.source, key.type), ...baseOperands]
      const valueType = extractedTypeOf(element, node)
      const getId = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
      const getOperation = buildOperation(
        getId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'object-pattern',
        operands,
        valueType,
        // [[Get]] on the source can throw: object destructuring requires
        // RequireObjectCoercible on its source, and a getter can itself throw.
        throwingCompletion,
        { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true }
      )
      operations.push(getOperation)
      const edge = baseEdge(getId)
      if (edge) edges.push(edge)
      const keyEdge = resultEdge(key.source, getId, 'key', 0)
      if (keyEdge) edges.push(keyEdge)
      chain(getId)

      const extracted = getOperation.results[0]?.id
      if (element.initializer && extracted) {
        // The step's own type is what the NAME is bound to, which is the
        // extraction's type with the absence already resolved away -- two
        // different types for two different operations, where before both read
        // the bound one.
        const defaultResult = contributeDefault(
          candidate,
          element,
          extracted,
          context.types.typeAt(element),
          element.initializer,
          context.types.typeAt(element.initializer)
        )
        if ('blocked' in defaultResult) {
          return asBlocked(candidate.id, 'destructuring', `object binding pattern default ${defaultResult.blocked}`, null)
        }
        operations.push(defaultResult)
        edges.push(...defaultResult.edges)
        // The default expression is part of IteratorBindingInitialization,
        // not a side branch that may float past the next element. Keeping it
        // in the evaluation chain both preserves left-to-right pattern order
        // and makes the finite IteratorClose region include a throwing
        // initializer before any later step or the normal trailing close.
        chain(defaultResult.id)
      }
    }

    // An EMPTY pattern still runs RequireObjectCoercible on its source
    // (ECMA-262 BindingInitialization of `{}`): `function f({} = null) {}`
    // throws a TypeError from `f()`. Every property step above checks its
    // own holder, so this step is minted only when there is no step to do it
    // -- exactly the assignment side's `object-source` operation.
    if (elements.length === 0) {
      const { operands: baseOperands, edge: baseEdge } = sourceOperand('base', known, baseType)
      const coercibleId = mintOperationId(context.ordinals, context.identities.nodeIdOf(node), 'destructuring')
      const coercible = buildOperation(
        coercibleId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'object-source',
        baseOperands,
        baseType,
        throwingCompletion,
        { readsMutableState: false, writesMutableState: false, allocates: false, callsUserCode: false }
      )
      operations.push(coercible)
      const edge = baseEdge(coercibleId)
      if (edge) edges.push(edge)
      chain(coercibleId)
    }

    const restElement = elements.find((element) => element.dotDotDotToken)
    if (restElement) {
      const { operands: baseOperands, edge: baseEdge } = sourceOperand('base', known, baseType)
      const valueType = boundElementType(restElement, context)
      const restId = mintOperationId(context.ordinals, context.identities.nodeIdOf(restElement), 'destructuring')
      const restOperation = buildOperation(
        restId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'rest-element',
        [...excludedKeys, ...baseOperands],
        valueType,
        normalCompletion,
        // CopyDataProperties allocates a fresh object from the remaining own
        // enumerable properties; it does not re-run any of the prior [[Get]]s.
        { readsMutableState: true, writesMutableState: false, allocates: true, callsUserCode: false }
      )
      operations.push(restOperation)
      const edge = baseEdge(restId)
      if (edge) edges.push(edge)
      // Each excluded-key operand may itself cite a computed-key expression's
      // result (see keyResolutionOf); that citation needs the same ValueEdge
      // treatment as any other cross-operation operand source.
      for (const excludedKey of excludedKeys) {
        const excludedEdge = resultEdge(excludedKey.source, restId, excludedKey.role, excludedKey.ordinal)
        if (excludedEdge) edges.push(excludedEdge)
      }
      chain(restId)
    }

    return { kind: 'operations', operations, edges }
  }

  /**
   * The type an array pattern READS for one position -- the array-side twin
   * of `extractedTypeOf`. A tuple source states its positions, so the step
   * reads that position's own type (an unstated position past the tuple's
   * end reads `undefined`). Any other array answers its element WITH
   * `undefined`: the iterator may be exhausted before this position (ECMA-262
   * IteratorBindingInitialization step "If iteratorRecord.[[done]] is true,
   * let v be undefined"), and typing the read with the name's bound type
   * would leave a `default-value` step testing a carrier with no absent state
   * -- the exact abort-instead-of-default `extractedTypeOf` documents.
   */
  /**
   * The element carrier of the pattern's own PUBLISHED source, when that source
   * is an array -- `null` whenever it is anything else.
   *
   * `structural.ts`'s `binding-pattern-is-its-source` is the authority on which
   * expression an erasing assertion leaves a pattern reading, and the source
   * operand (`patternSourceOperand`) takes its type from there. This asks that
   * one published answer rather than re-deriving it from the raw checker type,
   * so the element this step reads and the element `lower-destructuring.ts`
   * indexes out of the same value are interned once, not twice.
   */
  const arrayPatternSourceElementOf = (pattern: ts.ArrayBindingPattern): StructuralTypeId | null => {
    const shape = context.table.get(context.types.typeAt(pattern)).shape
    return shape.kind === 'array' ? shape.element : null
  }

  /**
   * What position `index` reads out of the pattern's own PUBLISHED source when
   * that source is a UNION of fixed-arity tuples -- the union of what each arm
   * states there, plus `undefined` when an arm is too short to reach it.
   * `null` for every other source.
   *
   * The sibling of `arrayPatternSourceElementOf`, for the one source shape that
   * has positions rather than a single element, and asking the same published
   * answer for the same reason.
   *
   * The checker flattens such a union to its NUMBER-INDEX type -- `number |
   * string | boolean` for `[number, string] | [number, boolean]` -- so the
   * general branch below typed position 0 as that whole union plus `undefined`.
   * The value is read the other way: `hasNativeIterationCursor`
   * (producers/shared.ts) admits a union of fixed-arity tuples as closed-shape,
   * so no iterator record stands between the pattern and the value, and
   * `ir/lower-destructuring.ts`'s tuple-union path reads position `index` off
   * whichever ARM is live and checks it against THIS step's carrier. It then
   * refused the flattened answer by name -- "not every arm of this union
   * answers this position with the same carrier" -- about arms that all answer
   * it identically. hono's `HonoRequest.routePath` over `Result<T> = [[T,
   * ParamIndexMap][], ParamStash] | [[T, Params][]]` is the measured case.
   *
   * `isFixedArityTupleType` because that is the predicate the source was
   * admitted by: the two must agree, or this would state positions for a source
   * the producer had already routed through the iterator protocol.
   */
  const arrayPatternSourcePositionOf = (pattern: ts.ArrayBindingPattern, index: number): StructuralTypeId | null => {
    const shape = context.table.get(context.types.typeAt(pattern)).shape
    if (shape.kind !== 'union' || shape.members.length === 0) return null
    if (!shape.members.every((member) => isFixedArityTupleType(context, member))) return null
    const members: StructuralTypeId[] = []
    for (const member of shape.members) {
      const arm = context.table.get(member).shape
      if (arm.kind !== 'tuple') return null
      const position = arm.elements[index]
      const type = position === undefined ? context.table.intern({ kind: 'primitive', primitive: 'undefined' }) : position.type
      if (!members.includes(type)) members.push(type)
    }
    const only = members.length === 1 ? members[0] : undefined
    return only ?? context.table.intern({ kind: 'union', members })
  }

  /**
   * One position's read type, reconciled with the ARRAY the step physically
   * indexes.
   *
   * Every answer below -- the census's, the raw type's tuple positions -- is a
   * statement about what the program says is AT a position. When the pattern's
   * published source is an array, `lower-destructuring.ts` reads the position
   * out of that array and requires this step's carrier to be its element (or
   * that plus the `undefined` a read past the end yields), because indexing an
   * `array-object` cannot produce anything else. Two shapes reach that
   * disagreement: a tuple ASSERTION over an array -- `const [createEvents,
   * options] = args as [(c: Ctx) => Events, number?]`, hono's
   * `defineWebSocketHelper` -- and a rest parameter whose checker tuple this
   * compiler already collapsed to the one Array the language binds. Neither
   * converts anything.
   *
   * The statement is not lost: `boundElementType` declares the NAME with it and
   * the narrowing happens on the store, exactly as `arr[0] as F` already
   * narrows an array read of a union.
   *
   * An answer that already CONTAINS the source's element -- it is that element,
   * or a union carrying it beside the read's absence -- is left exactly alone,
   * so every pattern that lowers today keeps the carrier it lowers with and
   * only a genuine disagreement is re-homed.
   */
  const reconciledWithSourceElement = (answer: StructuralTypeId, pattern: ts.ArrayBindingPattern): StructuralTypeId => {
    const sourceElement = arrayPatternSourceElementOf(pattern)
    // Opt-in, because three authorities can publish this one read -- the
    // pattern census, the raw type's tuple positions, and the source array's
    // own element -- and the lowering's refusal names the carrier without
    // naming which of them produced it.
    if (process.env['GEA_DEBUG_PATTERN']) {
      process.stderr.write(
        `[PATTERN] ${pattern.getText().slice(0, 60).replace(/\n/g, ' ')} answer=${answer} source=${sourceElement ?? 'none'}\n`
      )
    }
    if (sourceElement === null || answer === sourceElement) return answer
    const shape = context.table.get(answer).shape
    if (shape.kind === 'union' && shape.members.includes(sourceElement)) return answer
    return context.table.intern({
      kind: 'union',
      members: [sourceElement, context.table.intern({ kind: 'primitive', primitive: 'undefined' })]
    })
  }

  const extractedArrayTypeOf = (element: ts.BindingElement, pattern: ts.ArrayBindingPattern): StructuralTypeId => {
    const bound = context.types.typeAt(element)
    // The census's own answer first: a parameter's pattern has no single raw
    // source type when the census settled its callers as union arms.
    const censused = context.types.patternReadTypeAt(element)
    if (censused) return reconciledWithSourceElement(context.types.typeOf(censused), pattern)
    const base = context.checker.getNonNullableType(context.types.rawTypeAt(pattern))
    // A position the source can never fill -- past a tuple's end, or any
    // position of an array whose element is uninhabited (`[]` is `never[]`)
    // -- reads `undefined`, spelled in the NAME's own carrier with the absence
    // (`T | undefined`, not bare `undefined`) so the default that resolves it
    // merges two arms of one carrier rather than converting nothing into `T`.
    const absent = (): StructuralTypeId =>
      context.types.typeOf(context.checker.getNullableType(context.types.rawTypeAt(element), ts.TypeFlags.Undefined))
    if (context.checker.isTupleType(base)) {
      const stated = context.checker.getTypeArguments(base as ts.TupleTypeReference)[pattern.elements.indexOf(element)]
      return reconciledWithSourceElement(stated === undefined ? absent() : context.types.typeOf(stated), pattern)
    }
    // Asked before the number-index fallback, which is what flattens a union of
    // tuples into one element type; `arrayPatternSourcePositionOf` states why.
    const position = arrayPatternSourcePositionOf(pattern, pattern.elements.indexOf(element))
    if (position !== null) return position
    const indexed = context.checker.getIndexTypeOfType(base, ts.IndexKind.Number)
    if (!indexed) {
      // A non-array iterable -- a generator, a Set, a Map -- reads what it
      // yields, with the same `undefined` a plain array's position carries:
      // the cursor may be exhausted before this position, and the name's
      // bound type (bare `number` for `var [a, b] = g()`) has no arm for it.
      const yielded = iteratorYieldStructuralType(context, base, pattern)
      if (yielded === null) return bound
      return context.table.intern({
        kind: 'union',
        members: [yielded, context.table.intern({ kind: 'primitive', primitive: 'undefined' })]
      })
    }
    if ((indexed.flags & ts.TypeFlags.Never) !== 0) return absent()
    if (isUnusableEvidence(indexed)) return bound
    return context.types.typeOf(context.checker.getNullableType(indexed, ts.TypeFlags.Undefined))
  }

  const contributeArrayPattern = (candidate: CensusCandidate, node: ts.ArrayBindingPattern): CandidateContribution => {
    const source = candidate.id
    const known = patternSourceOperand(node)
    // The pattern node is contextually typed as an Array even when the value
    // it consumes was declared `any`/`unknown`.  Carry the source's own type
    // beside its citation so the iterator-record remains the authorized
    // dynamic carrier; using the pattern's requested view here would invent
    // an ArrayObject projection before `Array.isArray` had proved anything.
    const baseType = known?.type ?? context.types.typeAt(node)
    const operations: (DestructuringOperation | ProtocolOperation)[] = []
    const edges: SemanticEdge[] = []
    let previousId: OperationId | null = null
    const chain = (id: OperationId): void => {
      if (previousId) edges.push({ kind: 'evaluation', from: previousId, to: id })
      previousId = id
    }
    // GetIterator runs once, up front, regardless of how many elements follow
    // (even `const [] = x` acquires and then closes an iterator), and publishes
    // the iterator record every subsequent `next()` step consumes -- a step
    // advances the SHARED iterator, never the original base value again.
    let iteratorRecord: SemanticResultId | null = null
    let iteratorType = baseType
    const typedCustom = known !== null && !isDynamicIterationSource(context, baseType) && !hasNativeIterationCursor(context, baseType)
    if (typedCustom) {
      const steps = mintIteratorSteps(
        context,
        candidate,
        'iterator',
        { source: known.source, type: baseType, iterated: known.at, rawIterated: known.rawType },
        { includeGetMethod: true, includeClose: false, includeNext: false }
      )
      operations.push(...steps.operations)
      edges.push(...steps.edges)
      for (const step of steps.operations) edges.push(...valueEdgesInto(step.id, step.operands))
      iteratorRecord = steps.iteratorRecord
      iteratorType = steps.recordType
      previousId = steps.operations[steps.operations.length - 1]?.id ?? null
    } else {
      const { operands, edge: baseEdge } = sourceOperand('base', known, baseType)
      const id = mintOperationId(context.ordinals, source, 'destructuring')
      const result = mintResult(id, 'iterator-record', baseType)
      const getIterator: DestructuringOperation = {
        id,
        caller: candidate.caller,
        operands,
        results: [result],
        completion: throwingCompletion,
        effects: { readsMutableState: true, writesMutableState: false, allocates: true, callsUserCode: true },
        evaluationOrdinal: candidate.evaluationOrdinal,
        family: 'destructuring',
        form: 'array-pattern'
      }
      operations.push(getIterator)
      const edge = baseEdge(id)
      if (edge) edges.push(edge)
      chain(id)
      iteratorRecord = result.id
    }

    for (const element of node.elements) {
      const iteratorSource: OperandSource | null = iteratorRecord ? { kind: 'result', result: iteratorRecord } : null
      const { operands: iterOperands, edge: iterEdge } = sourceOperand('iterator', iteratorSource, iteratorType)

      if (ts.isOmittedExpression(element)) {
        // An elision still steps the iterator, discarding the value: no result
        // is published because nothing is bound to the discarded position.
        const id = mintOperationId(context.ordinals, source, 'destructuring')
        const op = buildOperation(
          id,
          candidate.caller,
          candidate.evaluationOrdinal,
          'array-pattern',
          iterOperands,
          null,
          throwingCompletion,
          {
            readsMutableState: true,
            writesMutableState: false,
            allocates: false,
            callsUserCode: true
          }
        )
        operations.push(op)
        const edge = iterEdge(id)
        if (edge) edges.push(edge)
        chain(id)
        continue
      }

      if (element.dotDotDotToken) {
        const valueType = context.types.typeAt(element)
        const id = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
        const op = buildOperation(
          id,
          candidate.caller,
          candidate.evaluationOrdinal,
          'rest-element',
          iterOperands,
          valueType,
          throwingCompletion,
          {
            readsMutableState: true,
            writesMutableState: false,
            allocates: true,
            callsUserCode: true
          }
        )
        operations.push(op)
        const edge = iterEdge(id)
        if (edge) edges.push(edge)
        chain(id)
        continue
      }

      const valueType = extractedArrayTypeOf(element, node)
      const stepId = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
      const stepOperation = buildOperation(
        stepId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'array-pattern',
        iterOperands,
        valueType,
        throwingCompletion,
        {
          readsMutableState: true,
          writesMutableState: false,
          allocates: false,
          callsUserCode: true
        }
      )
      operations.push(stepOperation)
      const edge = iterEdge(stepId)
      if (edge) edges.push(edge)
      chain(stepId)

      const extracted = stepOperation.results[0]?.id
      if (element.initializer && extracted) {
        // Same split as the object pattern above: the step reads with the
        // absence, the name is bound to the type the default resolves it to.
        const defaultResult = contributeDefault(
          candidate,
          element,
          extracted,
          context.types.typeAt(element),
          element.initializer,
          context.types.typeAt(element.initializer)
        )
        if ('blocked' in defaultResult) {
          return asBlocked(candidate.id, 'destructuring', `array binding pattern default ${defaultResult.blocked}`, null)
        }
        operations.push(defaultResult)
        edges.push(...defaultResult.edges)
        chain(defaultResult.id)
      }
    }

    // IteratorBindingInitialization closes a still-open iterator when a
    // finite pattern stops before exhaustion. A rest element drains instead,
    // so it has no trailing close. Dynamic sources and native generators are
    // the two stateful iterator carriers this pattern currently acquires;
    // typed arrays/tuples retain their positional fast paths.
    if (
      iteratorRecord &&
      finitePatternNeedsClose(baseType) &&
      !node.elements.some((element) => ts.isBindingElement(element) && element.dotDotDotToken !== undefined)
    ) {
      const id = mintOperationId(context.ordinals, source, 'destructuring')
      const close: DestructuringOperation = {
        id,
        caller: candidate.caller,
        operands: [operand('iterator', 0, { kind: 'result', result: iteratorRecord }, iteratorType, { kind: 'provenance' })],
        results: [mintResult(id, 'completion', context.table.intern({ kind: 'primitive', primitive: 'void' }))],
        completion: throwingCompletion,
        effects: { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true },
        evaluationOrdinal: candidate.evaluationOrdinal,
        family: 'destructuring',
        form: 'array-pattern-close'
      }
      const predecessor = operations[operations.length - 1]?.id ?? null
      operations.push(close)
      edges.push({ kind: 'value', result: iteratorRecord, to: id, role: 'iterator', ordinal: 0 })
      if (predecessor) edges.push({ kind: 'evaluation', from: predecessor, to: id })
      previousId = id
    }

    return { kind: 'operations', operations, edges }
  }

  const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })

  /**
   * Every member a union structural type holds, recursively flattened --
   * `extractedArrayAssignmentTypeOf`'s own "array element, unioned with the
   * absence a past-the-length read hands back" formula nests a SECOND union
   * one level up from a nested pattern's own position (`row: (number |
   * number[])[]`'s position 1 reads `union[union[number, number[]],
   * undefined]`, not a flat three-armed one), and this is what lets the
   * search below see through that nesting without caring how many levels
   * deep it is.
   */
  const flattenedUnionMembers = (id: StructuralTypeId, seen: Set<StructuralTypeId> = new Set()): StructuralTypeId[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const shape = context.table.get(id).shape
    return shape.kind === 'union' ? shape.members.flatMap((member) => flattenedUnionMembers(member, seen)) : [id]
  }

  /**
   * The one member of a union that is itself an 'array'/'tuple' shape --
   * `number | number[]`, a plain array's own element type that is itself a
   * union, where only the array arm supports a NESTED pattern's own
   * positional read at all (`representation/model.ts`'s
   * `soleArrayPatternCapableArm` is the identical question asked of the
   * REPRESENTATION this becomes, once one exists; this is its structural
   * twin, asked before one does, so `b`/`c` in `[a, [b, c]] = row` are typed
   * `number` rather than falling through to whatever `bound` answers for a
   * bare, unannotated `var`). `null` for zero such members, or for more than
   * one -- `number[] | string[]` is a genuine ambiguity this compiler does
   * not resolve, and returning `null` here is what keeps this function
   * falling through to `bound` for it rather than guessing.
   */
  const soleArrayPatternCapableMember = (id: StructuralTypeId): StructuralTypeId | null => {
    const capable = flattenedUnionMembers(id).filter((member) => {
      const kind = context.table.get(member).shape.kind
      return kind === 'array' || kind === 'tuple'
    })
    return capable.length === 1 ? (capable[0] ?? null) : null
  }

  /**
   * The array-assignment twin of `extractedArrayTypeOf` -- the type a
   * position reads BEFORE any default, for a target that is not a
   * `BindingElement`. There is no parameter-census shortcut to try first
   * (`patternReadTypeAt` binds only a formal parameter's own pattern), so
   * this asks the STRUCTURAL shape of the source directly -- a stated tuple
   * position, or an array element widened with the absence a position past
   * the source's length reads -- rather than asking the checker about the
   * PATTERN node's own raw type, the way `extractedArrayTypeOf` safely can
   * for a binding pattern (whose `rawTypeAt` already recurses to its source
   * via `mapper.typeAt`'s own binding-pattern branch). An `ArrayLiteralExpression`
   * written as an assignment TARGET has no such branch: the checker's own
   * answer for it is a contextually-typed TUPLE matching the target's own
   * element types, not the source's -- exactly the `baseType` trap
   * `arrayAssignmentSourceInfo` documents for the pattern's own iterator-record
   * type, so this reads the same already-correct STRUCTURAL answer instead.
   *
   * A `union` base -- a NESTED pattern's own `baseType`, fed by the enclosing
   * pattern's per-position read (`arrayAssignmentSourceInfo`'s nested branch)
   * -- recurses into whichever one member of it is array/tuple-shaped, so a
   * plain array's own union-typed element (`number | number[]`) is read the
   * SAME way a bare array/tuple base already is, rather than falling through
   * to the checker's `bound` (`any`, for an unannotated bare `var`).
   */
  const extractedArrayAssignmentTypeOf = (target: ts.Expression, position: number, baseType: StructuralTypeId): StructuralTypeId => {
    const bound = context.types.typeAt(target)
    const shape = context.table.get(baseType).shape
    if (shape.kind === 'tuple') {
      const stated = shape.elements[position]
      return stated ? stated.type : context.table.intern({ kind: 'union', members: [bound, undefinedType] })
    }
    if (shape.kind === 'array') {
      return context.table.intern({ kind: 'union', members: [shape.element, undefinedType] })
    }
    if (shape.kind === 'union') {
      const capable = soleArrayPatternCapableMember(baseType)
      if (capable !== null) return extractedArrayAssignmentTypeOf(target, position, capable)
    }
    return bound
  }

  /**
   * The FINAL type an array-assignment target position is written with --
   * post-default for a defaulted target, the SOURCE's own array type for a
   * rest target, and the raw extraction type for a bare one. Shared by the
   * pattern's own contribution (to type its default/rest operations) and the
   * write contribution (to type the value it stores), so the two can never
   * publish a store the extraction disagrees with.
   */
  const arrayAssignmentBoundTypeOf = (target: ArrayAssignmentTarget): StructuralTypeId => {
    const info = arrayAssignmentSourceInfo(target.pattern)
    const baseType = info?.type ?? context.types.typeAt(target.pattern)
    if (ts.isBinaryExpression(target.keyNode)) return context.types.typeAt(target.keyNode.left)
    if (ts.isSpreadElement(target.keyNode)) {
      // A rest target over a plain array IS that array's own type -- the
      // structural twin of `structural.ts`'s `arrayPatternRestTypeAt`, which
      // covers only a BINDING pattern's rest element. Asking the checker
      // about the target IDENTIFIER instead (`r` in `[a, ...r] = xs`) answers
      // whatever `r`'s own declaration states, which for an unannotated `var`
      // used only as an assignment target is `any` -- a second authority that
      // disagreed with the rest OPERATION's own array-of-source-element
      // carrier and left the write refusing to store what the read produced.
      const shape = context.table.get(baseType).shape
      if (shape.kind === 'array') return baseType
      return context.types.typeAt(target.keyNode.expression)
    }
    return extractedArrayAssignmentTypeOf(target.keyNode, target.position, baseType)
  }

  /**
   * This array pattern's own source value AND type -- the assignment-side
   * twin of `patternSourceOperand`. Three shapes: the top-level case
   * (`[a,b] = rhs`), the nested case (`[a, [b]] = [1, [2]]`, recomputing the
   * sibling position's extraction identity exactly as `patternSourceOperand`'s
   * own nested case does for a binding pattern), and a loop-head pattern with
   * no declaration keyword (`for ([a,b] of pairs)`), which reads the loop's
   * own `next` result the identical fixed way `patternSourceOperand`'s for-of
   * branch does.
   *
   * The TYPE travels with the source rather than coming from
   * `context.types.typeAt(pattern)`, because that question has no good answer
   * for an array literal in TARGET position: `mapper.typeAt`'s own early
   * branch recurses a BINDING pattern's type to its source for exactly this
   * reason, but has no such branch for an `ArrayLiteralExpression` written as
   * an assignment target, so the checker's raw answer is whatever contextual
   * TUPLE type it gave the literal -- which disagreed with the plain-array
   * carrier the source itself resolves to and left the pattern's own
   * `iterator-record` requiring a representation nothing could satisfy.
   * `contributeObjectAssignmentSource` avoids the identical trap by typing
   * its `object-source` operation from the cited source, never from the
   * pattern node; this is that same fix for the array-shaped sibling.
   */
  const arrayAssignmentSourceInfo = (pattern: ts.ArrayLiteralExpression): PatternSource | null => {
    const topLevel = arrayAssignmentSource(pattern)
    if (topLevel) {
      const cited = citeExpressionResult(topLevel, context)
      return cited.kind === 'source'
        ? {
            source: cited.source,
            type: context.types.typeAt(topLevel),
            rawType: context.types.rawTypeAt(topLevel),
            at: topLevel
          }
        : null
    }
    const nested = arrayAssignmentTargetOf(pattern)
    if (nested) {
      const id = operationId(context.identities.nodeIdOf(nested.keyNode), 'destructuring', nested.defaulted ? 1 : 0)
      const outer = arrayAssignmentSourceInfo(nested.pattern)
      const outerRaw = outer ? context.checker.getNonNullableType(outer.rawType) : null
      const positional =
        outerRaw && context.checker.isTupleType(outerRaw)
          ? context.checker.getTypeArguments(outerRaw as ts.TupleTypeReference)[nested.position]
          : outerRaw
            ? context.checker.getIndexTypeOfType(outerRaw, ts.IndexKind.Number)
            : undefined
      const yielded = !positional && outer ? iteratorYieldTypesOf(context.checker, outerRaw as ts.Type, outer.at) : null
      return {
        source: { kind: 'result', result: semanticResultId(id, 'value') },
        type: arrayAssignmentBoundTypeOf(nested),
        rawType:
          positional ?? (yielded?.length === 1 ? (yielded[0] ?? context.types.rawTypeAt(pattern)) : context.types.rawTypeAt(pattern)),
        at: pattern
      }
    }
    const parent = pattern.parent
    if (ts.isForOfStatement(parent) && parent.initializer === pattern) {
      const id = operationId(context.identities.nodeIdOf(parent), 'protocol', 2)
      // `context.types.typeAt(pattern)` asks the PATTERN's own type again --
      // the exact trap `arrayAssignmentSourceInfo`'s other two branches exist
      // to avoid (see the top-level `=` branch's own comment). A binding
      // pattern's declaration node is real declaration syntax the checker
      // types correctly on its own; an array LITERAL standing in the same
      // loop-head position is not, so this asks the loop's own ITERABLE for
      // its element type instead -- the one authority that actually states
      // what each iteration hands the pattern.
      const iterable = context.types.typeAt(parent.expression)
      const shape = context.table.get(iterable).shape
      const type = shape.kind === 'array' ? shape.element : context.types.typeAt(pattern)
      const iterableRaw = context.checker.getNonNullableType(context.types.rawTypeAt(parent.expression))
      const yielded = iteratorYieldTypesOf(context.checker, iterableRaw, parent.expression)
      return {
        source: { kind: 'result', result: semanticResultId(id, 'value') },
        type,
        rawType: yielded?.length === 1 ? (yielded[0] ?? context.types.rawTypeAt(pattern)) : context.types.rawTypeAt(pattern),
        at: pattern
      }
    }
    return null
  }

  /**
   * An array ASSIGNMENT pattern's read side: `[a, b] = rhs`, `[a, ...r] = xs`,
   * `[x = 3] = []`, `[a, [b]] = [1, [2]]`. The same GetIterator + per-position
   * `array-pattern`/`rest-element`/`default-value` operations
   * `contributeArrayPattern` publishes for a BINDING pattern, over elements
   * that are ordinary expressions instead of `BindingElement`s -- there is no
   * write here, unlike the binding case's own `initialize`: a simple target
   * (identifier/property/element access) writes through its OWN candidate,
   * `contributeArrayAssignmentWrite` below, the same split
   * `citeBoundElementValue`/`contributeBindingElement` already keep between
   * extraction and introduction. A nested pattern target needs no write here
   * either -- it is itself a `destructuring` candidate, and
   * `arrayAssignmentSourceInfo` above is what lets it cite this pattern's own
   * per-position extraction instead of guessing at one.
   */
  const contributeArrayAssignmentPattern = (candidate: CensusCandidate, node: ts.ArrayLiteralExpression): CandidateContribution => {
    const source = candidate.id
    const info = arrayAssignmentSourceInfo(node)
    const known = info?.source ?? null
    const baseType = info?.type ?? context.types.typeAt(node)
    const operations: (DestructuringOperation | ProtocolOperation)[] = []
    const edges: SemanticEdge[] = []
    let previousId: OperationId | null = null
    const chain = (id: OperationId): void => {
      if (previousId) edges.push({ kind: 'evaluation', from: previousId, to: id })
      previousId = id
    }
    let iteratorRecord: SemanticResultId | null = null
    let iteratorType = baseType
    const typedCustom = info !== null && !isDynamicIterationSource(context, baseType) && !hasNativeIterationCursor(context, baseType)
    if (typedCustom) {
      const steps = mintIteratorSteps(
        context,
        candidate,
        'iterator',
        { source: info.source, type: baseType, iterated: info.at, rawIterated: info.rawType },
        { includeGetMethod: true, includeClose: false, includeNext: false }
      )
      operations.push(...steps.operations)
      edges.push(...steps.edges)
      for (const step of steps.operations) edges.push(...valueEdgesInto(step.id, step.operands))
      iteratorRecord = steps.iteratorRecord
      iteratorType = steps.recordType
      previousId = steps.operations[steps.operations.length - 1]?.id ?? null
    } else {
      const { operands, edge: baseEdge } = sourceOperand('base', known, baseType)
      const id = mintOperationId(context.ordinals, source, 'destructuring')
      const result = mintResult(id, 'iterator-record', baseType)
      const getIterator: DestructuringOperation = {
        id,
        caller: candidate.caller,
        operands,
        results: [result],
        completion: throwingCompletion,
        effects: { readsMutableState: true, writesMutableState: false, allocates: true, callsUserCode: true },
        evaluationOrdinal: candidate.evaluationOrdinal,
        family: 'destructuring',
        form: 'array-pattern'
      }
      operations.push(getIterator)
      const edge = baseEdge(id)
      if (edge) edges.push(edge)
      chain(id)
      iteratorRecord = result.id
    }

    for (const element of node.elements) {
      const iteratorSource: OperandSource | null = iteratorRecord ? { kind: 'result', result: iteratorRecord } : null
      const { operands: iterOperands, edge: iterEdge } = sourceOperand('iterator', iteratorSource, iteratorType)

      if (ts.isOmittedExpression(element)) {
        const id = mintOperationId(context.ordinals, source, 'destructuring')
        const op = buildOperation(
          id,
          candidate.caller,
          candidate.evaluationOrdinal,
          'array-pattern',
          iterOperands,
          null,
          throwingCompletion,
          {
            readsMutableState: true,
            writesMutableState: false,
            allocates: false,
            callsUserCode: true
          }
        )
        operations.push(op)
        const edge = iterEdge(id)
        if (edge) edges.push(edge)
        chain(id)
        continue
      }

      if (ts.isSpreadElement(element)) {
        const target = arrayAssignmentTargetOf(element)
        const valueType = target ? arrayAssignmentBoundTypeOf(target) : context.types.typeAt(element.expression)
        const id = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
        const op = buildOperation(
          id,
          candidate.caller,
          candidate.evaluationOrdinal,
          'rest-element',
          iterOperands,
          valueType,
          throwingCompletion,
          {
            readsMutableState: true,
            writesMutableState: false,
            allocates: true,
            callsUserCode: false
          }
        )
        operations.push(op)
        const edge = iterEdge(id)
        if (edge) edges.push(edge)
        chain(id)
        continue
      }

      const position = node.elements.indexOf(element)

      if (
        element.kind === ts.SyntaxKind.BinaryExpression &&
        (element as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const assignment = element as ts.BinaryExpression
        const valueType = extractedArrayAssignmentTypeOf(assignment.left, position, baseType)
        const stepId = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
        const stepOperation = buildOperation(
          stepId,
          candidate.caller,
          candidate.evaluationOrdinal,
          'array-pattern',
          iterOperands,
          valueType,
          throwingCompletion,
          { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true }
        )
        operations.push(stepOperation)
        const edge = iterEdge(stepId)
        if (edge) edges.push(edge)
        chain(stepId)

        const extracted = stepOperation.results[0]?.id
        if (extracted) {
          const boundType = context.types.typeAt(assignment.left)
          const fallbackType = context.types.typeAt(assignment.right)
          const defaultResult = contributeDefault(candidate, element, extracted, boundType, assignment.right, fallbackType)
          if ('blocked' in defaultResult) {
            return asBlocked(candidate.id, 'destructuring', `array assignment pattern default ${defaultResult.blocked}`, null)
          }
          operations.push(defaultResult)
          edges.push(...defaultResult.edges)
          chain(defaultResult.id)
        }
        continue
      }

      // A bare target: an identifier, a property/element access, or a nested
      // pattern. Assignment syntax has no BindingElement-like wrapper to key
      // the step on besides the target itself.
      const valueType = extractedArrayAssignmentTypeOf(element, position, baseType)
      const stepId = mintOperationId(context.ordinals, context.identities.nodeIdOf(element), 'destructuring')
      const stepOperation = buildOperation(
        stepId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'array-pattern',
        iterOperands,
        valueType,
        throwingCompletion,
        { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true }
      )
      operations.push(stepOperation)
      const edge = iterEdge(stepId)
      if (edge) edges.push(edge)
      chain(stepId)
    }

    if (iteratorRecord && finitePatternNeedsClose(baseType) && !node.elements.some(ts.isSpreadElement)) {
      const id = mintOperationId(context.ordinals, source, 'destructuring')
      const close: DestructuringOperation = {
        id,
        caller: candidate.caller,
        operands: [operand('iterator', 0, { kind: 'result', result: iteratorRecord }, iteratorType, { kind: 'provenance' })],
        results: [mintResult(id, 'completion', context.table.intern({ kind: 'primitive', primitive: 'void' }))],
        completion: throwingCompletion,
        effects: { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true },
        evaluationOrdinal: candidate.evaluationOrdinal,
        family: 'destructuring',
        form: 'array-pattern-close'
      }
      const predecessor = operations[operations.length - 1]?.id ?? null
      operations.push(close)
      edges.push({ kind: 'value', result: iteratorRecord, to: id, role: 'iterator', ordinal: 0 })
      if (predecessor) edges.push({ kind: 'evaluation', from: predecessor, to: id })
      previousId = id
    }

    return { kind: 'operations', operations, edges }
  }

  /**
   * A simple array-assignment target's WRITE: an ordinary identifier
   * assignment or property/element store, citing the sibling
   * `contributeArrayAssignmentPattern` candidate's own per-position
   * extraction by recomputed identity -- never a lookup, for the same reason
   * `contributeBindingElement` cites `citeBoundElementValue` instead of one.
   */
  const contributeArrayAssignmentWrite = (candidate: CensusCandidate, node: ts.Expression): CandidateContribution => {
    const refuse = (reason: string): CandidateContribution => asBlocked(candidate.id, 'destructuring', reason, null)
    const target = arrayAssignmentWriteTargetOf(node)
    if (!target) return refuse('array assignment target has no enclosing array pattern')
    const boundType = arrayAssignmentBoundTypeOf(target)
    const value: OperandSource = {
      kind: 'result',
      result: semanticResultId(operationId(context.identities.nodeIdOf(target.keyNode), 'destructuring', target.defaulted ? 1 : 0), 'value')
    }
    let write: BindingOperation | PropertyOperation
    if (ts.isIdentifier(node)) {
      const symbol = context.checker.getSymbolAtLocation(node)
      const declaration = symbol ? context.identities.symbolDeclarationId(symbol) : null
      const declarationNode = symbol ? context.identities.declarationOfSymbol(symbol) : null
      if (!declaration || !declarationNode) return refuse('array assignment target has no declared binding cell')
      const id = mintOperationId(context.ordinals, candidate.id, 'binding')
      write = {
        id,
        family: 'binding',
        action: 'write',
        declaration,
        ...bindingKindOf(declarationNode),
        ...(context.commonJsBindings.has(declaration)
          ? {
              commonJs: {
                global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
                owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body')
              }
            }
          : {}),
        caller: candidate.caller,
        evaluationOrdinal: candidate.evaluationOrdinal,
        operands: [operand('value', 0, value, boundType)],
        results: [mintResult(id, 'value', boundType)],
        completion: normalCompletion,
        effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false }
      }
    } else {
      // `arrayAssignmentWriteTargetOf` admits only identifier/property/element
      // targets, so a non-identifier target here is always one of the other two.
      const access = node as ts.PropertyAccessExpression | ts.ElementAccessExpression
      const receiver = citeExpressionResult(access.expression, context)
      if (receiver.kind === 'unmodelled') return refuse(receiver.reason)
      const targetKey = ts.isPropertyAccessExpression(access)
        ? access.name.text
        : ts.isStringLiteralLike(access.argumentExpression) || ts.isNumericLiteral(access.argumentExpression)
          ? access.argumentExpression.text
          : null
      if (targetKey === null) return refuse('computed array assignment target keys are not yet modelled')
      const id = mintOperationId(context.ordinals, candidate.id, 'property')
      const receiverType = context.types.typeAt(access.expression)
      write = {
        id,
        family: 'property',
        internalMethod: 'set',
        strict: isStrictContext(access, context.buildIsStrict),
        keyIsComputed: false,
        descriptor: null,
        caller: candidate.caller,
        evaluationOrdinal: candidate.evaluationOrdinal,
        operands: [
          operand('receiver', 0, receiver.source, receiverType, { kind: 'provenance' }),
          operand('key', 0, { kind: 'constant', text: targetKey, literal: 'string' }, stringType),
          operand('value', 0, value, boundType)
        ],
        results: [mintResult(id, 'value', receiverType)],
        completion: throwingCompletion,
        effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: true }
      }
    }
    return { kind: 'operations', operations: [write], edges: valueEdgesInto(write.id, write.operands) }
  }

  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const { node } = candidate
    if (ts.isObjectLiteralExpression(node)) return contributeObjectAssignmentSource(context, candidate, node)
    if (isObjectAssignmentElement(node)) return contributeObjectAssignmentElement(context, candidate, node)
    if (ts.isObjectBindingPattern(node)) return contributeObjectPattern(candidate, node)
    if (ts.isArrayBindingPattern(node)) return contributeArrayPattern(candidate, node)
    if (ts.isArrayLiteralExpression(node)) return contributeArrayAssignmentPattern(candidate, node)
    if (arrayAssignmentWriteTargetOf(node)) return contributeArrayAssignmentWrite(candidate, node as ts.Expression)
    return asBlocked(candidate.id, 'destructuring', 'census produced a destructuring candidate of an unmodelled node kind', null)
  }

  return { family: 'destructuring', contribute }
}
