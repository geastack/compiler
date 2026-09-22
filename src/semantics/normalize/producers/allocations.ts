import ts from 'typescript'
import { operationId, semanticResultId, type OperationId, type SemanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { bindingKindOf } from './binding-kind.js'
import { declaresExactArms } from './exact-arms.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { citeExpressionResult } from './references.js'
import {
  sourceForValue,
  valueEdgesInto,
  hasNativeIterationCursor,
  staticPropertyKeyTextOf,
  isRuntimeSymbolMember,
  staticSpreadMembersOf,
  staticFunctionNameOf,
  staticClassNameOf,
  staticClassLengthOf,
  expectedParameterCountOf,
  ownPrototypePropertyOf
} from './shared.js'
import { isClosedTupleSpread, tupleSpreadReads } from './tuple-spread.js'
import { isDynamicIterationSource } from './protocol.js'
import { iteratorMethodSymbolOf } from './iteration-yield.js'
import type { SemanticEdge } from '../../model/edges.js'
import { sharedPrimitiveDomainOf } from '../../model/primitive-domain.js'
import { symbolPropertyKeyText, type StructuralMember, type StructuralShape } from '../../model/structural-types.js'
import { normalCompletion, pureEffects, type OperandSource, type SemanticOperand } from '../../model/operands.js'
import type { AllocationOperation, BindingOperation, ConversionRoleTarget, PropertyOperation } from '../../model/operations.js'

type AllocationNode =
  | ts.ObjectLiteralExpression
  | ts.ArrayLiteralExpression
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ClassExpression
  | ts.RegularExpressionLiteral

const unwrappedStructuralShape = (context: ProducerContext, type: StructuralTypeId): StructuralShape | null => {
  const shape = context.table.get(type).shape
  if ((shape.kind === 'declared' || shape.kind === 'object-anchor') && shape.body !== null)
    return unwrappedStructuralShape(context, shape.body)
  if (shape.kind === 'intersection' && shape.resolved !== null) return unwrappedStructuralShape(context, shape.resolved)
  return shape
}

const structuralMemberKeyText = (member: StructuralMember): string => {
  const key = member.key
  return key.kind === 'symbol' ? symbolPropertyKeyText(key.declaration) : String(key.value)
}

/** The declared field a statically keyed literal property installs, if any. */
const objectLiteralFieldTypeOf = (context: ProducerContext, receiverType: StructuralTypeId, key: string): StructuralTypeId | null => {
  const shape = unwrappedStructuralShape(context, receiverType)
  if (!shape || shape.kind !== 'object') return null
  return shape.members.find((member) => structuralMemberKeyText(member) === key)?.type ?? null
}

/** The concrete element slot each ordinary array-literal operand enters. */
const arrayLiteralElementRolesOf = (
  context: ProducerContext,
  shapeType: StructuralTypeId,
  operands: readonly SemanticOperand[]
): readonly ConversionRoleTarget[] => {
  const shape = unwrappedStructuralShape(context, shapeType)
  if (!shape) return []
  const roles: ConversionRoleTarget[] = []
  for (const element of operands) {
    if (element.role !== 'element') continue
    const type = shape.kind === 'array' ? shape.element : shape.kind === 'tuple' ? shape.elements[element.ordinal]?.type : undefined
    if (type !== undefined) roles.push({ role: 'element', ordinal: element.ordinal, owner: 'array-element', type })
  }
  return roles
}

/** A data-property key as the language sees it: a string, from a non-computed name. */
const keyTextOf = (name: ts.PropertyName | undefined): string | null => {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

/**
 * The key one object-literal member is defined under, and whether it is
 * computed.
 *
 * `{ [k]: v }` is two different constructs wearing one syntax, and which one it
 * is is decided by the key's TYPE, never by the brackets:
 *
 * - A key the type system pins -- `{ ['a']: v }`, `{ [K]: v }` for a
 *   literal-typed `const`, `{ [S]: v }` for a `unique symbol` -- is a STATIC
 *   key. The checker resolves the literal's own type to a named member
 *   (`{ a: V }`, and `keyof` lists it), the layout gives that member a struct
 *   field, and `o.a` reads it. So it is published exactly as a written name is:
 *   one constant operand, `keyIsComputed: false`. This is the identical rule
 *   `class-lifecycle.ts` already applies to `class C { [S]: T }`, generalized
 *   from `unique symbol` to every fixed key by `staticPropertyKeyTextOf`.
 * - A key that is genuinely a runtime value is a DYNAMIC definition, cited from
 *   whichever family normalized the bracketed expression and marked
 *   `keyIsComputed: true`. Whether the receiver can take one is not decided
 *   here: `preflight/property-access.ts` asks the target for the
 *   `<carrier>:define-own-property:true` recipe, which a dictionary claims and
 *   a struct does not.
 *
 * ToPropertyKey is what separates the second case from a refusal. `string`,
 * `number` and `symbol`, including literal unions in one domain, already have
 * one primitive carrier. No union dispatch or coercion is needed. A
 * numeric key needs no separate coercion here because the receiver a numeric
 * index signature derives is itself numerically keyed, so both sides of the
 * store already agree. Every other carrier (`any`/`unknown` above all, which
 * the checker admits where it admits nothing else) has no key conversion at
 * all, and is refused by name rather than spelled into a table whose key type
 * it does not have.
 */
const objectLiteralKeyOperand = (
  context: ProducerContext,
  name: ts.PropertyName,
  stringType: StructuralTypeId,
  receiverType: StructuralTypeId
): { readonly operand: SemanticOperand; readonly computed: boolean } | { readonly blocked: string } => {
  const constantKey = (text: string): { readonly operand: SemanticOperand; readonly computed: boolean } => ({
    operand: operand('key', 0, { kind: 'constant', text, literal: 'string' }, stringType),
    computed: false
  })
  if (!ts.isComputedPropertyName(name)) {
    const text = keyTextOf(name)
    return text === null
      ? { blocked: `an object literal property name of syntax kind ${ts.SyntaxKind[name.kind]} is not a data-property key` }
      : constantKey(text)
  }
  const keyType = context.types.typeAt(name.expression)
  const staticText = staticPropertyKeyTextOf(context, keyType)
  if (staticText !== null && !isRuntimeSymbolMember(context, receiverType, keyType)) return constantKey(staticText)
  const shape = context.table.get(keyType).shape
  const domain = sharedPrimitiveDomainOf((id) => context.table.get(id).shape, shape)
  const convertible = domain === 'string' || domain === 'number' || domain === 'symbol'
  if (!convertible) {
    const described = shape.kind === 'primitive' ? shape.primitive : shape.kind
    return {
      blocked: `a computed property key of type "${described}" has no ToPropertyKey conversion; only string, number and symbol keys convert`
    }
  }
  const cited = citeExpressionResult(name.expression, context)
  if (cited.kind === 'unmodelled') return { blocked: cited.reason }
  return { operand: operand('key', 0, cited.source, keyType), computed: true }
}

/**
 * The value an object literal method installs: the function object its own
 * allocation candidate publishes.
 *
 * The census routes a `MethodDeclaration` inside an object literal to the
 * allocation family in its own right (`census.ts`'s `familyOf`), exactly as it
 * routes the object literal itself, so `createAllocationProducer.contribute`
 * is called on it independently and mints a `function-object` allocation from
 * it via the same `isCallableNode` path an arrow-function property value goes
 * through. That call has not necessarily happened yet by the time this
 * property is defined -- producers run candidate by candidate, not in any
 * order this file controls -- so citing its result cannot be a lookup. It is
 * a prediction instead, computing the exact identity that call independently
 * mints from the same node: `sourceForValue`/`citeExpressionResult` do this
 * for every ordinary expression already, and this is that same rule stated
 * for a method, which is not an expression and so has no entry through that
 * path. The ordinal is 0 because the census gives a `MethodDeclaration` the
 * allocation family exactly once, so `mintOperationId` only ever assigns it
 * one identity.
 */
const methodValueOf = (
  method: ts.MethodDeclaration,
  context: ProducerContext
): { readonly source: OperandSource; readonly type: StructuralTypeId } => {
  const allocationId = operationId(context.identities.nodeIdOf(method), 'allocation', 0)
  return {
    source: { kind: 'result', result: semanticResultId(allocationId, 'value') },
    type: context.types.typeAt(method)
  }
}

/**
 * The data properties an object literal installs, as their own operations.
 *
 * A property key here is a language-level *value* -- the string
 * CreateDataPropertyOrThrow receives -- not an identity, which is why reading
 * the name node's text is correct rather than a source-shaped shortcut: two
 * different literals spelling the same key really do install the same key, and
 * that is exactly what the constant records. A method installs the same way:
 * `PropertyDefinitionEvaluation` for a `MethodDefinition` is `CreateMethod`
 * followed by the identical `CreateDataPropertyOrThrow` an ordinary value
 * property gets, which is why this is one loop and not two -- a method is a
 * data-property definition whose value happens to come from a function
 * allocation instead of an evaluated expression.
 */

/**
 * `{ ...a, b: 1 }` -- CopyDataProperties (ECMA-262 7.3.25), for a source whose
 * shape is statically known.
 *
 * The spec copies the source's OWN ENUMERABLE properties, and for a data-only
 * object shape that set is exactly its members: one `[[Get]]` on the source
 * and one `CreateDataPropertyOrThrow` on the target per member, in the shape's
 * own order, installed at the position the spread occupies so a later literal
 * key still overwrites it -- which is the whole of the spec's semantics here.
 *
 * Refused BY NAME, never approximated, when the source is not that:
 *
 *  - an INDEX SIGNATURE means the own-property set is not known until runtime,
 *    and copying only the declared members would silently drop the rest;
 *  - an ACCESSOR must be CALLED -- `{ ...o }` copies a getter's returned value,
 *    not the getter -- and calling one is a user-code invocation this producer
 *    does not model here;
 *  - a `signature`-shaped member is a METHOD, which on a class instance lives
 *    on the prototype and is therefore not own-enumerable at all; the shape
 *    alone cannot tell an own function-valued field from a prototype method,
 *    so both are refused rather than one guessed;
 *  - `membersDropped` says a projection already filtered this body, so its
 *    member list is not the source's own-property set (see
 *    `representation/object-shape.ts` for why that bit exists);
 *  - a symbol key is skipped by CopyDataProperties only when non-enumerable,
 *    and the shape does not record enumerability, so it is refused too.
 *
 * The two operations per member are minted on the SPREAD's own node, so their
 * ordinals are consecutive within `(node, 'property')` exactly as
 * `operationsOfNode` (normalize/gating.ts) requires.
 */
const spreadCopyOf = (
  property: ts.SpreadAssignment,
  receiver: SemanticResultId,
  receiverType: StructuralTypeId,
  candidate: CensusCandidate,
  context: ProducerContext
):
  | { readonly operations: readonly PropertyOperation[]; readonly edges: readonly SemanticEdge[] }
  | { readonly blocked: string }
  | { readonly deferred: OperationId } => {
  const sourceType = context.types.typeAt(property.expression)
  const admitted = staticSpreadMembersOf(context, sourceType)
  if ('blocked' in admitted) {
    // A source with no statically known own-property set is not a refusal
    // here any more -- `producers/protocol.ts`'s `contributeObjectSpread`
    // mints a `protocol: 'spread'` operation for this EXACT `SpreadAssignment`
    // node under exactly this condition (the same shared predicate,
    // `staticSpreadMembersOf`, so the two can never disagree about which
    // sources take which path), and that operation performs the runtime
    // `CopyDataProperties` copy this field-by-field loop cannot. So this
    // member is DEFERRED to that operation rather than blocking the whole
    // literal: the id is predicted, not re-minted -- `protocol.ts` owns this
    // node's `'protocol'` family census assignment and mints the operation
    // itself, exactly as `methodValueOf` above predicts an object-literal
    // method's own allocation id without re-minting it.
    //
    // Whether that operation can actually LOWER -- the receiver must resolve
    // to a dictionary-capable carrier, and the source's arm kinds must be
    // ones the copy knows how to render -- is answered later, by
    // `ir/lower-protocol.ts`, which fails closed by name when it cannot; this
    // producer does not re-derive that answer, which is not available until
    // representation is derived.
    return { deferred: operationId(context.identities.nodeIdOf(property), 'protocol', 0) }
  }
  // Only the fields the LITERAL's own type declares are installed.
  //
  // `{ ...extra, ...base }` typed `Extra` really does carry `base`'s extra keys
  // in JavaScript, and a native record cannot: its layout is fixed, and the
  // struct this literal allocates is the one its own type names. Which is also
  // the only view any consumer can ever take of it -- no typed read reaches a
  // key the type does not declare, and a native record has no dynamic
  // enumeration to expose one. So the copy is scoped to the target's own
  // fields, rather than emitting a store into a member that does not exist.
  // A target whose shape is not statically known has no field set to scope to,
  // and refuses by name here rather than installing a guess.
  const target = staticSpreadMembersOf(context, receiverType)
  if ('blocked' in target) {
    return { blocked: `an object spread into a target with no statically known field set cannot place its copies (${target.blocked})` }
  }
  const installable = new Map(
    target.members.flatMap((member) => (member.key.kind === 'symbol' ? [] : [[String(member.key.value), member.type] as const]))
  )
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const sourceValue = sourceForValue(context, property.expression)
  const operations: PropertyOperation[] = []
  const edges: SemanticEdge[] = []
  const spreadNode = context.identities.nodeIdOf(property)
  for (const member of admitted.members) {
    // Every member reaching here was admitted by `staticSpreadMembersOf`
    // above -- data-only, non-accessor, string- or number-keyed -- so the key
    // is readable without a second check that could disagree with it.
    if (member.key.kind === 'symbol') continue
    const key = String(member.key.value)
    const destinationType = installable.get(key)
    if (destinationType === undefined) continue
    const read = mintOperationId(context.ordinals, spreadNode, 'property')
    const readOperands: SemanticOperand[] = [
      operand('receiver', 0, sourceValue, sourceType),
      operand('key', 0, { kind: 'constant', text: key, literal: 'string' }, stringType)
    ]
    operations.push({
      id: read,
      family: 'property',
      internalMethod: 'get',
      strict: true,
      keyIsComputed: false,
      descriptor: null,
      caller: candidate.caller,
      operands: readOperands,
      results: [mintResult(read, 'value', member.type)],
      completion: normalCompletion,
      effects: { ...pureEffects, readsMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    })
    edges.push(...valueEdgesInto(read, readOperands))
    const install = mintOperationId(context.ordinals, spreadNode, 'property')
    const installOperands: SemanticOperand[] = [
      operand('receiver', 0, { kind: 'result', result: receiver }, receiverType, { kind: 'provenance' }),
      operand('key', 0, { kind: 'constant', text: key, literal: 'string' }, stringType),
      operand('value', 0, { kind: 'result', result: semanticResultId(read, 'value') }, member.type)
    ]
    operations.push({
      id: install,
      family: 'property',
      internalMethod: 'define-own-property',
      strict: true,
      keyIsComputed: false,
      descriptor: { writable: true, enumerable: true, configurable: true },
      caller: candidate.caller,
      operands: installOperands,
      // The source member is what this read PRODUCES; the destination member
      // is what the following definition STORES. They can differ under a
      // contextual literal type (`{ p: any }` spread into `{ p: void }`), so
      // the conversion role must name the latter or preflight audits the
      // source against itself and silently skips the real store conversion.
      conversionRoles: [{ role: 'value', ordinal: 0, owner: 'declared-field', type: destinationType }],
      results: [mintResult(install, 'value', receiverType)],
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
      evaluationOrdinal: candidate.evaluationOrdinal
    })
    edges.push(...valueEdgesInto(install, installOperands), { kind: 'evaluation', from: read, to: install })
  }
  return { operations, edges }
}

const definePropertiesOf = (
  node: ts.ObjectLiteralExpression,
  receiver: SemanticResultId | null,
  receiverType: StructuralTypeId,
  candidate: CensusCandidate,
  context: ProducerContext
): { readonly operations: readonly PropertyOperation[]; readonly edges: readonly SemanticEdge[] } | { readonly blocked: string } => {
  if (!receiver) return { blocked: 'an object literal allocation published no result for its property definitions to install onto' }
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const operations: PropertyOperation[] = []
  const edges: SemanticEdge[] = []
  let previous: OperationId | null = null

  for (const property of node.properties) {
    // A spread installs one property per member of its source, in the shape's
    // own order and at the position the spread occupies -- so a later literal
    // key still overwrites what it copied, exactly as the language orders it.
    if (ts.isSpreadAssignment(property)) {
      const copy = spreadCopyOf(property, receiver, receiverType, candidate, context)
      if ('blocked' in copy) return copy
      if ('deferred' in copy) {
        // This member's copy is performed by the `protocol: 'spread'`
        // operation `protocol.ts` publishes for this same node, not by any
        // operation minted here -- see `spreadCopyOf`. Still order it exactly
        // where the source places it: `{ 'Content-Type': x, ...headers }`
        // sets the known key FIRST and the spread's runtime copy can OVERWRITE
        // it, so the evaluation edge into and out of the deferred operation is
        // the only thing here that keeps that order observable.
        if (previous) edges.push({ kind: 'evaluation', from: previous, to: copy.deferred })
        previous = copy.deferred
        continue
      }
      for (const copied of copy.operations) {
        if (previous) edges.push({ kind: 'evaluation', from: previous, to: copied.id })
        previous = copied.id
      }
      operations.push(...copy.operations)
      edges.push(...copy.edges)
      continue
    }
    // An accessor installs no *value*: `MethodDefinitionEvaluation` gives it an
    // accessor descriptor, whose get/set slots hold the bodies this literal's
    // own shape already names (`structural-declarations.ts`'s
    // `literalAccessorOf`), so there is no data property to define here and no
    // storage for one to be defined into. Creating the function object is pure,
    // so skipping the definition drops nothing observable -- the body itself is
    // still allocated, by this producer, at the accessor's own candidate.
    if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      // ...but only when the shape this literal ALLOCATES really does name it.
      // The literal's own shape always does (`literalAccessorOf`); the shape a
      // CONTEXTUAL type supplies need not -- an interface's `get next(): T` has
      // no body, so it is an ordinary data member of a shape the host
      // implements, and a literal laid out as that interface had its getter
      // skipped here and no field written for it either. The record allocated
      // with a default-constructed `CallableObject` in that slot then
      // segfaulted on the first read (`typed-custom-iterator-close.ts`'s
      // `typedNextGetterSource`). Matched on the DECLARATION's own id rather
      // than on a re-derived key, so a computed well-known-symbol accessor is
      // checked by the same test as a written one.
      const own = context.identities.declarationIdOf(property)
      const shape = unwrappedStructuralShape(context, receiverType)
      const named =
        shape !== null &&
        shape.kind === 'object' &&
        shape.members.some((member) => member.accessor?.getter === own || member.accessor?.setter === own)
      if (!named) {
        return {
          blocked:
            'an object literal accessor whose allocated shape declares the member as ordinary data has nowhere to install its body; ' +
            'reading it would call an unset slot'
        }
      }
      continue
    }
    const name = property.name
    const isMethod = ts.isMethodDeclaration(property)
    // Read before the narrowing below exhausts this union, so the refusal can
    // still name the form it refused if the union ever grows a member the
    // three tests do not cover.
    const propertyKind = property.kind
    if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || isMethod)) {
      // A member form this producer does not model at all -- saying so is
      // better than installing a property under a guessed name.
      return { blocked: `an object literal property of syntax kind ${ts.SyntaxKind[propertyKind]} has no readable data-property key` }
    }
    const key = objectLiteralKeyOperand(context, name, stringType, receiverType)
    if ('blocked' in key) return key
    const id = mintOperationId(context.ordinals, context.identities.nodeIdOf(property), 'property')
    // `{ x }` is sugar for `{ x: x }`: the value is a read of the same
    // identifier that names the key. A method has no separate value
    // expression at all -- its own declaration node *is* the value, by way of
    // the allocation it independently publishes.
    const value = isMethod
      ? methodValueOf(property, context)
      : (() => {
          const valueNode = ts.isPropertyAssignment(property) ? property.initializer : (property as ts.ShorthandPropertyAssignment).name
          return { source: sourceForValue(context, valueNode), type: context.types.typeAt(valueNode) }
        })()
    const operands: SemanticOperand[] = [
      operand('receiver', 0, { kind: 'result', result: receiver }, receiverType, { kind: 'provenance' }),
      key.operand,
      operand('value', 0, value.source, value.type)
    ]
    const fieldType =
      key.operand.source.kind === 'constant' ? objectLiteralFieldTypeOf(context, receiverType, key.operand.source.text) : null
    operations.push({
      id,
      family: 'property',
      internalMethod: 'define-own-property',
      strict: true,
      keyIsComputed: key.computed,
      // CreateDataPropertyOrThrow installs a fully permissive data property;
      // these are the attributes the language fixes, not a default chosen here.
      descriptor: { writable: true, enumerable: true, configurable: true },
      caller: candidate.caller,
      operands,
      ...(fieldType === null ? {} : { conversionRoles: [{ role: 'value', ordinal: 0, owner: 'declared-field', type: fieldType }] }),
      // The result is the object with this property installed, not the value
      // that was installed: CreateDataPropertyOrThrow returns nothing useful,
      // and it is the object that the literal's consumers go on to cite.
      results: [mintResult(id, 'value', receiverType)],
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
      evaluationOrdinal: candidate.evaluationOrdinal
    })
    edges.push(...valueEdgesInto(id, operands))
    // Properties install left to right, and that order is observable through
    // enumeration and through side effects in the values. Sharing the
    // candidate's ordinal says nothing about which of these runs first, so the
    // order travels on an explicit edge, which is the only thing a consumer is
    // allowed to read it from.
    if (previous) edges.push({ kind: 'evaluation', from: previous, to: id })
    previous = id
  }
  return { operations, edges }
}

/**
 * The four syntax kinds that allocate a callable.
 *
 * `allocatedKindOf` reaches `function-object` for exactly these, so this is the
 * same predicate stated as a type guard -- the narrowing is what lets the
 * function identity be minted from a node the checker agrees is a declaration.
 * An object-literal method belongs here for the same reason a function
 * expression does: `PropertyDefinitionEvaluation` for a `MethodDefinition`
 * calls `OrdinaryFunctionCreate` before it ever installs the property, exactly
 * as `NamedEvaluation`/plain evaluation does for a function expression value,
 * so a method allocates a callable independently of whatever installs it.
 * (A `MethodDeclaration` reaches this producer at all only when the census
 * decided its parent is not class-like -- `census.ts`'s `familyOf` routes a
 * class method to `class-lifecycle` instead -- so the guard below never has
 * to distinguish the two contexts itself.)
 */
type CallableAllocationNode =
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

const isCallableNode = (node: AllocationNode): node is CallableAllocationNode =>
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  // An object literal's own accessor. `MethodDefinitionEvaluation` for a
  // `get`/`set` runs `OrdinaryFunctionCreate` exactly as it does for a method;
  // what differs is only what the definition that follows installs, and that
  // is the *literal's* business, below. (A class accessor never arrives here:
  // the census routes it to `class-lifecycle`, which allocates it itself.)
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

/** A declaration instantiated with the enclosing function body, before that body's statements execute. */
const isBodyLevelFunctionDeclaration = (node: AllocationNode): node is ts.FunctionDeclaration => {
  if (!ts.isFunctionDeclaration(node) || !ts.isBlock(node.parent)) return false
  const owner = node.parent.parent
  return (
    (ts.isFunctionDeclaration(owner) ||
      ts.isFunctionExpression(owner) ||
      ts.isArrowFunction(owner) ||
      ts.isMethodDeclaration(owner) ||
      ts.isConstructorDeclaration(owner) ||
      ts.isGetAccessorDeclaration(owner) ||
      ts.isSetAccessorDeclaration(owner)) &&
    owner.body === node.parent
  )
}

/**
 * `null` for a node this producer does not model.
 *
 * The census routes an object literal's own accessor definitions here too,
 * and those are not any of the kinds below. Falling through to
 * `function-object` for them would publish a callable allocation that names no
 * function -- a shape `AllocationOperation.callable` cannot honestly fill --
 * so the unmodelled kinds are refused by name instead.
 */
/**
 * The binding a `function f() {}` statement initializes.
 *
 * A function declaration does two things: it instantiates a callable, and it
 * initializes the binding that names it -- hoisted, so the name holds the
 * function before any statement in the enclosing body runs. A function
 * *expression* with a BindingIdentifier does the same two things in a
 * different scope: `InstantiateOrdinaryFunctionExpression` builds a fresh
 * declarative environment, gives it exactly one immutable binding for that
 * name, makes it the closure's `[[Environment]]`, and initializes it with the
 * closure before returning. So it introduces a cell too, and publishing only
 * the declaration's was the defect -- every read of a named function
 * expression's own name (the `requestAnimationFrame(loop)` idiom, one
 * occurrence in each of twelve corpus apps) named a declaration no operation
 * introduced, and `bindingReference` refused it as an ambient one with no host
 * protocol. Which execution context owns the cell is already answered by
 * `candidate.caller`: the environment is created by whatever evaluates the
 * expression, exactly as a declaration's cell belongs to the body that hoists
 * it. Nothing leaks to the enclosing scope from this, because scoping is the
 * checker's answer, not this one's -- an outer name never resolves to this
 * declaration, so no read outside the body can reach the cell.
 *
 * An anonymous function expression still names nothing, and neither does an
 * object-literal method: its name is a property key installed by
 * `definePropertiesOf`, not a binding any scope resolves.
 */
const nameBindingOf = (
  node: CallableAllocationNode,
  allocation: AllocationOperation,
  candidate: CensusCandidate,
  context: ProducerContext
): readonly BindingOperation[] => {
  if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) || !node.name) return []
  const value = allocation.results[0]
  if (!value) return []
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  // Mutability and the dead zone come from the one shared authority rather
  // than from constants here, because the read side asks the same function --
  // `references.ts`, `computations.ts` and `invocations.ts` all reach a
  // binding read's kind through `bindingKindOf`. A declaration binding is
  // still mutable and hoisted; a function expression's self-name is the
  // immutable, dead-zone-free binding the language creates for it. Two
  // producers computing this separately is what `BindingKind`'s own doc
  // comment forbids, and a cell whose introduction and reads disagreed about
  // its lifetime would be one cell with two lifetimes.
  const { mutable, temporalDeadZone } = bindingKindOf(node)
  return [
    {
      id,
      family: 'binding',
      action: 'initialize',
      declaration: context.identities.declarationIdOf(node),
      mutable,
      temporalDeadZone,
      ...(isBodyLevelFunctionDeclaration(node) ? { hoistedFunctionInitialization: true } : {}),
      caller: candidate.caller,
      operands: [operand('initializer', 0, { kind: 'result', result: value.id }, allocation.shape)],
      results: [mintResult(id, 'value', allocation.shape)],
      completion: normalCompletion,
      effects: { ...pureEffects, writesMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    }
  ]
}

/**
 * A spread source that is neither a native cursor nor dynamic, but declares
 * its own `[Symbol.iterator]` -- a class with a `*[Symbol.iterator]()`, the
 * shape every hand-written iterable has.
 *
 * `protocol.ts` already mints the whole GetIterator record for it; only this
 * producer refused to consume one, so `[...new Range(1, 4)]` was blocked for
 * a protocol that was installed. The operand cites that record exactly as a
 * dynamic spread's does, and `ir/lower-allocation.ts` gathers the cursor it
 * carries.
 */
const gathersDeclaredIterator = (context: ProducerContext, expression: ts.Expression): boolean => {
  // A plain array, a Set, a string, a tuple -- everything with a native range
  // copy -- declares `[Symbol.iterator]` too, and `protocol.ts` mints NO
  // record for those (its `consumedWithoutIterator` bypass returns first). So
  // they are excluded here rather than asked: citing a record nobody publishes
  // is a withheld certificate, which is what `[...state.items, action.item]`
  // became when this predicate answered on the symbol alone.
  const type = context.types.typeAt(expression)
  if (hasNativeIterationCursor(context, type) || isDynamicIterationSource(context, type) || isClosedTupleSpread(context, expression))
    return false
  return iteratorMethodSymbolOf(context.types.rawTypeAt(expression)) !== null
}

const allocatedKindOf = (node: AllocationNode): AllocationOperation['allocated'] | null => {
  if (ts.isObjectLiteralExpression(node)) return 'object-literal'
  if (ts.isArrayLiteralExpression(node)) return 'array-literal'
  if (ts.isClassExpression(node)) return 'class-constructor-object'
  if (ts.isRegularExpressionLiteral(node)) return 'regexp-object'
  return isCallableNode(node) ? 'function-object' : null
}

/**
 * The outermost `as T`/`<T>` assertion in an unbroken chain of assertions and
 * parentheses wrapping `node`, or `null` when `node` is not the operand of one.
 *
 * `expr as unknown as T` -- the standard double-cast idiom for bypassing
 * structural compatibility -- parses as two nested `AsExpression`s, the inner
 * one asserting `unknown`. `producers/invocations.ts`'s own
 * `enclosingTypeAssertion` correctly reads only the immediate wrapper for its
 * single-assertion call sites; reading only the immediate parent here would
 * answer `unknown` and miss the caller's actual intent, so this climbs
 * through every chained assertion to the last one instead of stopping at the
 * first.
 */
const outermostTypeAssertion = (node: ts.Node): ts.AsExpression | ts.TypeAssertion | null => {
  let current: ts.Node = node
  let outermost: ts.AsExpression | ts.TypeAssertion | null = null
  for (;;) {
    let parent: ts.Node | undefined = current.parent
    while (parent !== undefined && ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent
      parent = current.parent
    }
    if (parent === undefined || !(ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) || parent.expression !== current) {
      return outermost
    }
    outermost = parent
    current = parent
  }
}

/**
 * Whether `id`'s structural shape is a call+construct signature, through
 * `unwrappedStructuralShape` above -- the one place this file already
 * answers "what does a `declared`/intersection wrapper actually name," so a
 * second, narrower unwrap here would be the same two-authorities risk this
 * file's own header on `unwrappedStructuralShape`'s callers exists to avoid.
 */
const isCallAndConstructShape = (context: ProducerContext, id: StructuralTypeId): boolean => {
  const signature = unwrappedStructuralShape(context, id)
  return signature?.kind === 'signature' && signature.call.length > 0 && signature.construct.length > 0
}

/**
 * A plain function's allocation shape, honoring an immediate `as T`/`<T>`
 * assertion that adds a construct signature the literal's own inferred type
 * never states.
 *
 * TypeScript's checker never gives an ordinary `FunctionExpression`/
 * `FunctionDeclaration` a construct signature of its own -- `valueTypeAt`
 * below reflects exactly what the checker inferred, a call-only signature --
 * even though ECMA-262 15.2.4 OrdinaryFunctionCreate gives every non-arrow,
 * non-method, non-generator, non-async function real `[[Construct]]`
 * behavior and a real own "prototype" property. A program that casts such a
 * value to a call+construct interface (`function (v) {...} as unknown as
 * DualCallableConstructor`, an ajv-style `((v) => boolean) & { new (...): T
 * }` intersection) is not lying about the runtime -- it is naming a fact the
 * checker's own inference just does not surface for typed function syntax
 * the way it does for the untyped `this.x = ` constructor-function idiom
 * (`structural-receiver.ts`'s `jsConstructorReceiverOf`).
 *
 * Safe to honor because this compiler renders the callable's own construct
 * thunk from its own body (`targets/cpp/translation-unit.ts`'s
 * `constructThunkOf`, `targets/cpp/emit-callable.ts`'s `emitAllocateCallable`)
 * -- unlike `JSON.parse`'s `any` (`producers/invocations.ts`'s
 * `jsonParseResultOverride`), this is never trusting an opaque host's word
 * for a shape it does not itself build. Restricted to the allocation's own
 * DIRECT assertion chain -- never a later `as T` on a separate reference to
 * the same declaration (`const reflected = Factory as FactoryWithDefault`
 * elsewhere in the file), which would need a whole-program census of every
 * reachable cast this producer is not given -- and to ordinary function
 * syntax only: an arrow, a method, a generator or an async function is never
 * a legal `new` target in real JavaScript, and honoring a cast that claims
 * otherwise here would certify an impossible construction instead of
 * refusing it.
 *
 * That census was BUILT and reverted on 2026-09-08, measured rather than
 * argued: it resolves the cast correctly and still buys nothing, because the
 * asserted type in every program that wants this is an INTERSECTION
 * (`typeof Factory & (new (v: number) => T)`) and an intersection of a call
 * type with a construct type interns as an object shape with zero members --
 * so `isCallAndConstructShape` answers `false` for the DIRECT spelling too.
 * The wall is intersection resolution, not the reach of this rule. See
 * a finding of the same date.
 */
const constructibleAssertionShapeOf = (
  context: ProducerContext,
  node: ts.FunctionExpression | ts.FunctionDeclaration
): StructuralTypeId | null => {
  if (node.asteriskToken !== undefined) return null
  if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0) return null
  const assertion = outermostTypeAssertion(node)
  if (!assertion) return null
  const asserted = context.types.typeAt(assertion)
  return isCallAndConstructShape(context, asserted) ? asserted : null
}

export const createAllocationProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'allocation',
  contribute: (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node as AllocationNode

    if (ts.isArrayLiteralExpression(node)) {
      // A spread is admitted when its own source has a NATIVE ITERATION CURSOR
      // -- a plain array, a `Set<T>`, a `Map<K, V>`, a `string` or a
      // `Generator<T, ...>`, the same predicate `protocol.ts`'s bypass uses so
      // the two halves cannot disagree about which sources take the range copy
      // -- or when it is a CLOSED TUPLE (positional expansion,
      // `tuple-spread.ts`). Anything else -- a user-defined iterable, a
      // `Symbol.iterator` method written by hand, a tuple with an
      // optional/rest element -- still
      // needs the general iterator protocol, which is not installed, so it is
      // refused here exactly as before. `.find()` rather than `.some()`
      // because the refusal needs to name a candidate; which one is a detail,
      // not part of the contract.
      const inadmissibleSpread = node.elements.find(
        (element) =>
          ts.isSpreadElement(element) &&
          !hasNativeIterationCursor(context, context.types.typeAt(element.expression)) &&
          !isDynamicIterationSource(context, context.types.typeAt(element.expression)) &&
          !isClosedTupleSpread(context, element.expression) &&
          !gathersDeclaredIterator(context, element.expression)
      )
      if (inadmissibleSpread) {
        return {
          kind: 'blocked',
          blocker: blocked(candidate.id, 'allocation', 'array literal spread needs the iterator protocol, which is not installed', 'P4')
        }
      }
    }

    const operationIdentity = mintOperationId(context.ordinals, candidate.id, 'allocation')
    const operands: SemanticOperand[] = []
    // The reads a tuple spread expands to, and the edges wiring each one to the
    // receiver it indexes. Collected here so the contribution can publish them
    // alongside the allocation itself.
    const expansions: PropertyOperation[] = []
    const expansionEdges: SemanticEdge[] = []

    if (ts.isArrayLiteralExpression(node)) {
      // The operand's own ordinal is its position in the ELEMENT SEQUENCE the
      // literal builds, which stops being the syntactic index the moment a
      // tuple spread expands one written element into several. Everything
      // downstream reads the ordinal as that sequence position -- `lowerTupleLiteral`
      // matches operand `n` to the record field keyed `String(n)`,
      // `arrayLiteralSlotsOf` merges the `element`/`spread` roles back into one
      // ordered run by it, and `arrayLiteralElementTarget` looks a tuple field
      // up by it -- so it is counted, never taken from `forEach`'s index.
      let position = 0
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) {
          // A hole is not an element whose value is `undefined`; it is a slot
          // the language defines but this site leaves empty, and the two are
          // observably different (`in`, enumeration order on assignment).
          operands.push(operand('element', position, { kind: 'absent' }, context.types.typeOf(context.checker.getUndefinedType())))
          position += 1
        } else if (ts.isSpreadElement(element)) {
          // A closed tuple is expanded into one ordinary `element` operand per
          // position, each citing its own `[[Get]]`: the literal `[...pair, 4]`
          // then reaches every later layer as the three-element literal it
          // provably is, needing no spread-aware code anywhere downstream.
          const expanded = tupleSpreadReads(context, candidate, element.expression)
          if (expanded) {
            expansions.push(...expanded.operations)
            expansionEdges.push(...expanded.edges)
            for (const slot of expanded.positions) {
              operands.push(operand('element', position, slot.source, slot.type))
              position += 1
            }
            continue
          }
          // Admitted only when `hasNativeIterationCursor` passed above. This operand
          // names the spread's own source (the whole array, e.g. `xs`), not a
          // single element, so `ir/lower-allocation.ts` can range-copy it
          // directly instead of through a materialized iterator. The distinct
          // 'spread' role is what tells this operand apart from an ordinary
          // element at the same position -- collapsing the two under 'element'
          // would leave that lowering no way to know which push shape a given
          // operand needs.
          const sourceType = context.types.typeAt(element.expression)
          // A dynamic spread consumes the one GetIterator record the protocol
          // candidate publishes.  Re-reading the source here would invoke
          // @@iterator twice and lose observable iterator identity.
          const source =
            isDynamicIterationSource(context, sourceType) || gathersDeclaredIterator(context, element.expression)
              ? {
                  kind: 'result' as const,
                  result: semanticResultId(operationId(context.identities.nodeIdOf(element), 'protocol', 1), 'iterator-record')
                }
              : sourceForValue(context, element.expression)
          operands.push(operand('spread', position, source, sourceType))
          position += 1
        } else {
          operands.push(operand('element', position, sourceForValue(context, element), context.types.typeAt(element)))
          position += 1
        }
      }
    }

    if (ts.isRegularExpressionLiteral(node)) {
      // A regexp literal's pattern and flags are SOURCE TEXT, exactly as a
      // template literal's segments are, so they travel the same way: as
      // constant operands the producer read off the token. No step of the
      // language computes either one (ECMA-262 22.2.4.1 `RegExp(pattern,
      // flags)` receives them already final from the literal's Parse Node),
      // and nothing downstream should have to re-lex the literal to get them.
      //
      // The split is on the LAST `/`, which is exact rather than approximate:
      // the grammar is `/ RegularExpressionBody / RegularExpressionFlags`, and
      // `RegularExpressionFlags` is a sequence of `IdentifierPartChar`, which
      // never includes `/`. So the final `/` in the token is always the
      // terminating one, even when the body contains `[/]` or `\/`.
      const text = node.text
      const terminator = text.lastIndexOf('/')
      if (terminator <= 0) {
        return {
          kind: 'blocked',
          blocker: blocked(
            candidate.id,
            'allocation',
            `a regular-expression literal's token ${JSON.stringify(text)} has no closing delimiter to split its flags off`,
            'P1'
          )
        }
      }
      const patternType = context.table.intern({ kind: 'primitive', primitive: 'string' })
      operands.push(operand('pattern-source', 0, { kind: 'constant', text: text.slice(1, terminator), literal: 'string' }, patternType))
      operands.push(operand('pattern-flags', 0, { kind: 'constant', text: text.slice(terminator + 1), literal: 'string' }, patternType))
    }

    const allocated = allocatedKindOf(node)
    if (!allocated) {
      return {
        kind: 'blocked',
        blocker: blocked(
          candidate.id,
          'allocation',
          `no allocation is modelled for a node of syntax kind ${ts.SyntaxKind[node.kind]}`,
          'P1'
        )
      }
    }
    // A callable's shape is what its *declaration* denotes, which for an
    // accessor is its own signature and not the property type its name carries
    // -- see `structural-declarations.ts`'s `accessorSignatureOf`. An ordinary
    // function directly wrapped in an `as T`/`<T>` assertion that adds a
    // construct signature overrides that default -- see
    // `constructibleAssertionShapeOf` just above.
    const constructibleShape =
      ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) ? constructibleAssertionShapeOf(context, node) : null
    const shape = constructibleShape ?? (isCallableNode(node) ? context.types.valueTypeAt(node) : context.types.typeAt(node))

    const operation: AllocationOperation = {
      id: operationIdentity,
      family: 'allocation',
      caller: candidate.caller,
      allocated,
      // Only a callable allocation names a function; everything else states
      // `null` rather than an id that would be meaningless at that coordinate.
      callable: isCallableNode(node) ? context.identities.functionIdOf(node) : null,
      ...(isCallableNode(node)
        ? {
            functionSource: node.getText(),
            functionName: staticFunctionNameOf(node),
            functionLength: expectedParameterCountOf(node),
            generatorFunction: 'asteriskToken' in node && node.asteriskToken !== undefined,
            ...(declaresExactArms(node) ? { exactArms: true } : {}),
            ...(ownPrototypePropertyOf(node) === null ? {} : { ownPrototypeProperty: ownPrototypePropertyOf(node) === true })
          }
        : {}),
      // A class expression's constructor object names its class and its
      // `[[Name]]` (`const A = class {}` is "A"), exactly as
      // `class-lifecycle.ts`'s `allocateFunctionObject` does for a declaration.
      ...(ts.isClassExpression(node)
        ? {
            classDeclaration: context.identities.declarationIdOf(node),
            functionName: staticClassNameOf(node),
            functionLength: staticClassLengthOf(node)
          }
        : {}),
      shape,
      ...(allocated === 'array-literal' ? { conversionRoles: arrayLiteralElementRolesOf(context, shape, operands) } : {}),
      ...(isBodyLevelFunctionDeclaration(node) ? { hoistedFunctionInitialization: true } : {}),
      operands,
      results: [mintResult(operationIdentity, 'value', shape)],
      // The allocation itself never throws; a throwing element or heritage
      // evaluation is that sub-expression's own operation, not this one's.
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: false, allocates: true, callsUserCode: false },
      // Evaluation position comes from the shared per-caller counter, never
      // from a source offset: the two are not comparable, so an operation
      // ordinalled by offset sorts before every operation ordinalled by count
      // regardless of the order either actually runs in.
      evaluationOrdinal: candidate.evaluationOrdinal
    }

    if (isCallableNode(node)) {
      return {
        kind: 'operations',
        operations: [operation, ...nameBindingOf(node, operation, candidate, context)],
        edges: valueEdgesInto(operationIdentity, operands)
      }
    }

    if (!ts.isObjectLiteralExpression(node)) {
      // The expanded tuple-spread reads are published with the allocation that
      // cites them, never separately: `contribution.ts` commits one candidate
      // atomically, so an allocation whose operands name results published by
      // a *different* candidate would be withheld the moment that candidate
      // were blocked, and the two must stand or fall together.
      return {
        kind: 'operations',
        operations: [...expansions, operation],
        edges: [...expansionEdges, ...valueEdgesInto(operationIdentity, operands)]
      }
    }

    // An object literal is OrdinaryObjectCreate followed by one
    // CreateDataPropertyOrThrow per property, and modelling it as a single
    // allocation carrying value operands loses every key: `{ a: 1 }` and
    // `{ x: 1 }` would publish identical operations. Each definition is its
    // own operation, keyed on its own property node, so its key survives and
    // so the emitted object is the one the source describes.
    const definitions = definePropertiesOf(node, operation.results[0]?.id ?? null, shape, candidate, context)
    if ('blocked' in definitions) {
      return { kind: 'blocked', blocker: blocked(candidate.id, 'allocation', definitions.blocked, 'P1') }
    }
    return {
      kind: 'operations',
      operations: [operation, ...definitions.operations],
      edges: [...valueEdgesInto(operationIdentity, operands), ...definitions.edges]
    }
  }
})
