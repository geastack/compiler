import ts from 'typescript'
import { bodyReadsThis } from '../structural-receiver.js'
import {
  deferredIntrinsicProtocolLedgerOf,
  intrinsicProtocolRequirementKind,
  type IntrinsicProtocolRequirement
} from '../deferred-intrinsic-protocols.js'
import type { DeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { namedSlotWritesOf, provenSelfBindWith, type ProvenSelfBind } from './callable-reach.js'
import type { ValueFlowIndex, ValueWrite } from './model.js'
import { sourceClassKeyReadPlanOf, type SourceClassFamilyQuery } from './source-class-data.js'

/**
 * A method slot whose every value a read can observe is the method bound to
 * the slot's own object: `this.m = this.m.bind(this)` in the class's
 * constructor, before anything can see the instance.
 *
 * A bound function ignores the `this` it is called with (ECMA-262 10.4.1.1),
 * so a call through such a slot needs no receiver, and a caller that passes
 * another one -- an event dispatcher that calls `listener.call(this, event)`
 * with the dispatching target -- is not a type error. The slot itself only
 * proves half of that: before the store, a read of the slot is the unbound
 * prototype method, which does use its receiver. So the fact is the self-bind
 * AND the order:
 *
 * - the class has no `extends`: a base constructor runs with the instance
 *   before this constructor's body, and may call an override that reads the
 *   slot;
 * - no instance field initializer, constructor parameter initializer or
 *   decorator can mention `this`, and every constructor statement before the
 *   self-bind either does not mention `this` at all or is a plain store
 *   `this.k = <expression without this>` into a key no accessor of the class
 *   declares. None of them can return, so the self-bind always runs before
 *   the constructor finishes. Until then no code holds the instance, and
 *   after it every read of the slot finds the bound function;
 * - every program write that names the key, and every write the flow index
 *   files under the slot, is a proven self-bind -- so the slot is never
 *   re-pointed at an unbound function, and never deleted;
 * - no class of the family declares the key as anything but a method, so a
 *   subclass field or accessor cannot replace what the constructor stored.
 *
 * `bindSources` are the `this.m` reads inside each self-bind. They run before
 * their own store, so they keep the method's convention.
 */
export interface SelfBoundSlot {
  readonly bindSources: ReadonlySet<ts.Expression>
}

const LEDGER_SCOPE = 'self-bound-slot'
const published = new WeakMap<
  DeferredIntrinsicProtocolLedger,
  { readonly all: IntrinsicProtocolRequirement[]; readonly seen: Map<ts.Node, Set<string>> }
>()

/** Keep a surviving answer's intrinsic obligations: this proof is asked outside any census capture. */
const publish = (ledger: DeferredIntrinsicProtocolLedger, requirements: readonly IntrinsicProtocolRequirement[]): void => {
  if (requirements.length === 0) return
  ledger.include(requirements)
  let held = published.get(ledger)
  if (!held) published.set(ledger, (held = { all: [], seen: new Map() }))
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
  if (added) ledger.replace(LEDGER_SCOPE, held.all)
}

/** Whether evaluating `node` can observe the current `this`, including through arrows, `super` and a direct `eval`. */
const mentionsThis = (node: ts.Node): boolean => {
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return true
  if (bodyReadsThis(node, true)) return true
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'eval') {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

/** Whether `node` holds a `return` of the function it is spelled in. */
const returnsFromOwnFunction = (node: ts.Node): boolean => {
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (ts.isReturnStatement(current)) {
      found = true
      return
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

const unparenthesized = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

const memberNameOf = (member: ts.ClassElement): string | null =>
  member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null

/**
 * `this.k = v` that stores a value which cannot hold the instance, into a key
 * whose store runs no code: no accessor of the class declares it, and it is
 * not `__proto__`, whose store is `Object.prototype`'s setter.
 */
const isInertReceiverStore = (owner: ts.ClassLikeDeclaration, statement: ts.Statement): boolean => {
  if (!ts.isExpressionStatement(statement)) return false
  const store = unparenthesized(statement.expression)
  if (!ts.isBinaryExpression(store) || store.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  const destination = store.left
  if (!ts.isPropertyAccessExpression(destination) || destination.expression.kind !== ts.SyntaxKind.ThisKeyword) return false
  if (!ts.isIdentifier(destination.name) || destination.name.text === '__proto__') return false
  const key = destination.name.text
  const accessor = owner.members.some(
    (member) => (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && memberNameOf(member) === key
  )
  return !accessor && !mentionsThis(store.right) && !returnsFromOwnFunction(store.right)
}

const hasDecorators = (node: ts.Node): boolean => ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0

const declaredClassTypeOf = (checker: ts.TypeChecker, owner: ts.ClassLikeDeclaration): ts.Type | null => {
  const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
  const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
  return type?.isClassOrInterface() ? type : null
}

const proofs = new WeakMap<ValueFlowIndex, Map<ts.MethodDeclaration, SelfBoundSlot | null>>()

/**
 * The self-bound slot `method` is, given every write the flow index files
 * under its symbol, or `null` when any part of the fact is not proven.
 */
export const selfBoundSlotOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  method: ts.MethodDeclaration,
  writes: readonly ValueWrite[]
): SelfBoundSlot | null => {
  let held = proofs.get(flow)
  if (!held) proofs.set(flow, (held = new Map()))
  if (held.has(method)) return held.get(method) ?? null
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  let answer: SelfBoundSlot | null = null
  if (ledger !== null) {
    const { value, requirements } = ledger.capture(() => prove(checker, flow, method, writes))
    if (value !== null) publish(ledger, requirements)
    answer = value
  }
  held.set(method, answer)
  return answer
}

const prove = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  method: ts.MethodDeclaration,
  writes: readonly ValueWrite[]
): SelfBoundSlot | null => {
  const owner = method.parent
  if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null
  if (!ts.isIdentifier(method.name) || method.body === undefined) return null
  if (ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Static) return null
  if (owner.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) return null
  if (hasDecorators(owner) || owner.members.some(hasDecorators)) return null
  const key = method.name.text
  const type = declaredClassTypeOf(checker, owner)
  if (type === null) return null
  const family: SourceClassFamilyQuery = { kind: 'declared', receiver: type }
  const constructor = owner.members.find(
    (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined
  )
  if (constructor === undefined || constructor.body === undefined) return null
  if (constructor.parameters.some(mentionsThis)) return null
  for (const member of owner.members) {
    if (!ts.isPropertyDeclaration(member) || ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) continue
    if (mentionsThis(member)) return null
  }

  const selfBinds: ProvenSelfBind[] = []
  for (const write of writes) {
    if (write.value === null) return null
    const selfBind = provenSelfBindWith(checker, flow, write.value, () => family)
    if (selfBind === null || selfBind.key !== key) return null
    selfBinds.push(selfBind)
  }
  // A store through a receiver the checker does not tie to this symbol is
  // still a store into the key on whatever object it reaches. Another
  // self-bind leaves that object's slot bound to that same object.
  const stores = new Set(selfBinds.map((selfBind) => selfBind.store))
  for (const access of namedSlotWritesOf(checker, flow, key)) {
    const store = access.parent
    if (!ts.isBinaryExpression(store) || store.left !== access) return null
    if (stores.has(store)) continue
    const foreign = provenSelfBindWith(checker, flow, store.right, (object) => ({
      kind: 'declared',
      receiver: checker.getTypeAtLocation(object)
    }))
    if (foreign === null || foreign.store !== store) return null
  }

  const statements = constructor.body.statements
  const ordered = statements.findIndex((statement) => {
    if (!ts.isExpressionStatement(statement)) return false
    const store = unparenthesized(statement.expression)
    return (
      ts.isBinaryExpression(store) &&
      stores.has(store) &&
      store.left.kind === ts.SyntaxKind.PropertyAccessExpression &&
      flow.receiverOwnerOf((store.left as ts.PropertyAccessExpression).expression) === constructor
    )
  })
  if (ordered < 0) return null
  for (const statement of statements.slice(0, ordered)) {
    if (isInertReceiverStore(owner, statement)) continue
    if (mentionsThis(statement) || returnsFromOwnFunction(statement)) return null
  }

  // A subclass field or accessor under the key replaces, or intercepts, what
  // the constructor stored; a subclass method is only what `this.m` binds.
  const plan = sourceClassKeyReadPlanOf(checker, flow, family, key)
  if (plan === null) return null
  for (const member of plan.classes.keys()) {
    if (!ts.isClassDeclaration(member) && !ts.isClassExpression(member)) return null
    const memberType = declaredClassTypeOf(checker, member)
    const symbol = memberType && checker.getPropertyOfType(memberType, key)
    if (!symbol?.declarations?.length) return null
    const declaredOnlyAsMethod = symbol.declarations.every(
      (declaration) =>
        (ts.isMethodDeclaration(declaration) && declaration.body !== undefined) ||
        (ts.isBinaryExpression(declaration) && stores.has(declaration))
    )
    if (!declaredOnlyAsMethod) return null
  }
  return { bindSources: new Set(selfBinds.map((selfBind) => selfBind.source)) }
}
