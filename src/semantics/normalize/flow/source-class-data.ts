import ts from 'typescript'
import { isClassSpelledSourceClass, isConstructorFunction, type SourceClass, type ValueFlowIndex } from './model.js'
import { ownedClassReceiverInventoryOf } from './owned-class-receivers.js'
import { isSourceInstanceMethod } from './source-prototype-method-identity.js'
import type { ExactClassAllocationOrigins } from './member-call-forwarding.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { objectPrototypeMemberNames } from '../../../representation/record-fields.js'
import { accessorPassthroughAliasOf } from '../structural-declarations.js'
import { isGlobalObjectConstructor, isStandardGlobalValue, isUnusableEvidence } from '../derived-expression-type.js'
import { unwrapNaming } from './targets.js'

/**
 * The declaration-only spelling `define-property-source-transform.ts` emits for
 * a `this`-receiver `Object.defineProperties` data descriptor: a bare
 * `/** @type {...} *\/ this.key;` access standing as its own statement.
 *
 * It is the DECLARATION of a data member and executes nothing -- the property
 * is created by the definition call the transform keeps beside it, with that
 * call's own attributes. TypeScript's JS class inference reads it as a member
 * declaration and hands it back as the property's declaration node, so a proof
 * that accepts `this.key = value` and refuses this one is refusing the same
 * fact written in the spelling this compiler itself chose. Three's `LOD`
 * declares `levels` that way, and reading it was the terminal of 35 escapes.
 */
export const declaredDataMemberAccess = (declaration: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(declaration) || ts.isElementAccessExpression(declaration)) &&
  ts.isExpressionStatement(declaration.parent) &&
  declaration.parent.expression === declaration

/** A source member declaration that creates a plain data property. */
const isSourceDataDeclaration = (declaration: ts.Declaration): boolean =>
  !declaration.getSourceFile().isDeclarationFile &&
  (ts.isPropertyDeclaration(declaration) ||
    ts.isParameterPropertyDeclaration(declaration, declaration.parent) ||
    declaredDataMemberAccess(declaration) ||
    (ts.isBinaryExpression(declaration) &&
      declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(declaration.left) || ts.isElementAccessExpression(declaration.left))))

const carriesTypeParameter = (type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.TypeParameter) !== 0 || (type.isUnionOrIntersection() && type.types.some(carriesTypeParameter))

/**
 * The plain data member a get/set accessor PAIR does nothing but forward to,
 * on one particular owner class -- or `null` when this owner does not prove
 * it. `isSourceDataDeclaration` above is right to refuse an accessor by
 * itself: an accessor runs code, and its own declaration says nothing about
 * what that code does. This asks the narrower, additional question of
 * whether the code it runs is PROVABLY nothing but forwarding to a real data
 * member, so that a read through the accessor can be answered from the same
 * authority that answers for the member it forwards to -- three's
 * `Texture.image` (`get image() { return this.source.data } set image(v) {
 * this.source.data = v }`) is the motivating case: every read of it across
 * `WebGLTextures.js` is a `Source.data` read wearing a different name.
 *
 * Every one of these must hold, on THIS owner, for the answer to be anything
 * but `null`:
 *
 * - the pair is syntactically a passthrough of one access, both halves
 *   agreeing (`accessorPassthroughAliasOf`, `structural-declarations.ts`);
 * - the receiver the access reads off -- `this` itself, or `this.<field>` --
 *   resolves on this owner's declared type to a class-or-interface type, so
 *   there really is a further object to ask;
 * - the member the access names on THAT type is itself proven a plain data
 *   declaration by `isSourceDataDeclaration` -- the SAME guard, asked again,
 *   never a looser one, so a target that is itself an accessor (a chain of
 *   proxies) refuses rather than being assumed transparent;
 * - the target's own checker type is not vacuous (`any`, `unknown`, or an
 *   unsubstituted type parameter) -- an alias to nothing is not evidence.
 *
 * Callers enumerate the outer owner's family. A forwarded receiver field
 * has its own family, which must also exclude accessor overrides.
 */
const accessorPassthroughDataMemberOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  owner: ts.Type,
  member: ts.Symbol
): { readonly declaration: ts.Declaration; readonly type: ts.Type } | null => {
  const declarations = member.declarations ?? []
  if (declarations.length !== 2) return null
  const getter = declarations.find(ts.isGetAccessorDeclaration)
  const setter = declarations.find(ts.isSetAccessorDeclaration)
  if (!getter || !setter) return null
  const alias = accessorPassthroughAliasOf(getter, setter)
  if (!alias) return null
  let receiverType: ts.Type
  if (alias.receiverField === null) receiverType = owner
  else {
    const receiverSymbol = checker.getPropertyOfType(owner, alias.receiverField)
    if (!receiverSymbol?.declarations?.length || !receiverSymbol.declarations.every(isSourceDataDeclaration)) return null
    const receiverDeclaration = receiverSymbol.valueDeclaration ?? receiverSymbol.declarations?.[0]
    if (!receiverDeclaration) return null
    receiverType = checker.getTypeOfSymbolAtLocation(receiverSymbol, receiverDeclaration)
  }
  if (!receiverType.isClassOrInterface()) return null
  const target = checker.getPropertyOfType(receiverType, alias.key)
  if (!target?.declarations?.length || !target.declarations.every(isSourceDataDeclaration)) return null
  if (alias.receiverField !== null) {
    // The outer owner's family does not establish the nested receiver's
    // family. A Source subclass may replace data with an accessor too.
    const source = receiverType.getSymbol()?.valueDeclaration
    if (!source || (!ts.isClassDeclaration(source) && !ts.isClassExpression(source))) return null
    const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([source]))
    if (!inventory) return null
    for (const candidate of inventory.classes) {
      const type = declaredClassTypeOf(checker, candidate)
      const member = type && checker.getPropertyOfType(type, alias.key)
      if (!member?.declarations?.length || !member.declarations.every(isSourceDataDeclaration)) return null
    }
  }
  const targetDeclaration = target.valueDeclaration ?? target.declarations[0]!
  const targetType = checker.getTypeOfSymbolAtLocation(target, targetDeclaration)
  if (isUnusableEvidence(targetType) || (targetType.flags & ts.TypeFlags.Unknown) !== 0 || carriesTypeParameter(targetType)) return null
  return { declaration: targetDeclaration, type: targetType }
}

/** A declared descriptor family and a value's allocation family are distinct queries. */
export type SourceClassFamilyQuery =
  | { readonly kind: 'declared'; readonly receiver: ts.Type }
  | {
      readonly kind: 'value'
      readonly receiver: ts.Type
      readonly expression: ts.Expression
      readonly originsOf: (expression: ts.Expression) => ExactClassAllocationOrigins | null
    }

/**
 * `this`/`super`, or a local binding that is provably nothing else: its only
 * whole-slot write is its own initializer, and that initializer is `this`/
 * `super`. TypeScript's own JS constructor-function member inference scans
 * only a LITERAL `this.<name> = ...`; three's `WebGLRenderer` instead writes
 * most of its instance data through exactly this alias, often from inside a
 * nested helper (`WebGLRenderer.js`: `const _this = this; ... function
 * initGLContext() { ... _this.shadowMap = shadowMap; ... }`). The checker's
 * inferred type for `WebGLRenderer` then has no `shadowMap` member at all --
 * not a wrong answer, an absent one, because the checker never looked. The
 * value-flow index already proves an alias like this exact for other
 * purposes (`callable-reach.ts`'s `thisFamilyAt`, walking straight through
 * `const _this = this`); a member-declaration authority that recognises only
 * the bare keyword was refusing a fact the flow graph had already settled.
 */
const thisReceiverOf = (flow: ValueFlowIndex, expression: ts.Expression): ts.Expression | null => {
  const value = unwrapNaming(expression)
  if (value.kind === ts.SyntaxKind.ThisKeyword || value.kind === ts.SyntaxKind.SuperKeyword) return value
  if (!ts.isIdentifier(value)) return null
  const declaration = flow.targetOf(value)?.declaration
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  const write = writes.length === 1 ? writes[0] : undefined
  if (!write || write.edge !== 'declaration-initializer' || write.value === null) return null
  const initial = unwrapNaming(write.value)
  return initial.kind === ts.SyntaxKind.ThisKeyword || initial.kind === ts.SyntaxKind.SuperKeyword ? initial : null
}

/**
 * `owner.<key>` assignments `checker.getPropertyOfType` cannot see: `this.
 * <key> = value` written through a `thisReceiverOf` alias, from directly
 * inside a CONSTRUCTOR FUNCTION's own body or a real class's own
 * `constructor(...)` method. A sibling of `callable-reach.ts`'s
 * `instanceMemberWritesOf`, kept as its own small walk rather than shared:
 * that inventory is keyed to a literal `this`/`super` receiver on purpose,
 * for an unrelated inheritance question multiple other consumers already
 * depend on, and widening it there would change what every one of them
 * sees. This one exists only to hand the checker-backed member/read/data
 * plans below a fallback for the specific keys the checker's own inference
 * never learns -- scoped to a constructor's own frame exactly the way a
 * real class's inferred type is scoped to its own declared members.
 *
 * `owner` is the whole class/function declaration, but `flow.receiverOwnerOf`
 * answers with the innermost enclosing FUNCTION-LIKE node -- for a
 * constructor-function `owner` that IS `owner` itself, but for a real
 * `class Owner { constructor() { ... } }` it is the `constructor` method,
 * never the class node. Three's `WebGLRenderer` is the real-file case: an
 * ES6 class whose constructor keeps a `const _this = this` alias and installs
 * `properties`/`textures`/... through it from a nested `initGLContext`
 * helper, same shape as a constructor function's own alias writes -- so the
 * comparison frame must be the constructor method, not the class.
 */
/**
 * Every alias-installed key at once, grouped -- rather than one key at a time
 * -- because the struct-field-layout census (`structural.ts`'s
 * `classInstanceBodyOf`) does not know in advance WHICH keys the checker's
 * `type.getProperties()` is missing; it has to enumerate the whole extra set
 * to append it to the shape. The per-key `constructorInstalledMemberWritesOf`
 * below is now a thin filter over this, so the member-plan/key-read-plan
 * call sites (which DO already know the one key they are asking about) keep
 * their existing shape.
 */
// This is a pure function of (flow, owner): the alias-installed write scan
// consults no proof assumption park, only the whole-program write inventory
// and the owner's own frame. But the member-plan/key-read-plan call sites
// below reach it once per VALUE query (`sourceClassDataMemberPlanOf`'s outer
// cache is proof-local and deliberately bypassed for those -- see
// `cachedByAnchorAndKey`'s `proofLocal` branch), which is once per re-ask
// inside the escape proof's coinductive cycle -- millions of times on
// the three.js app. Recomputing an O(allWrites) scan that many times turned a single
// full-program pass into the dominant cost; cache it by (flow, owner) here,
// independent of that proof-local machinery, the same way every other
// checker-stable answer in this module is held in a WeakMap off `flow`.
const constructorInstalledMemberDeclarationCache = new WeakMap<
  ValueFlowIndex,
  WeakMap<SourceClass, ReadonlyMap<string, readonly ts.BinaryExpression[]>>
>()

export const constructorInstalledMemberDeclarationsOf = (
  flow: ValueFlowIndex,
  owner: SourceClass
): ReadonlyMap<string, readonly ts.BinaryExpression[]> => {
  let byOwner = constructorInstalledMemberDeclarationCache.get(flow)
  if (!byOwner) constructorInstalledMemberDeclarationCache.set(flow, (byOwner = new WeakMap()))
  const cached = byOwner.get(owner)
  if (cached) return cached
  const computed = constructorInstalledMemberDeclarationsUncachedOf(flow, owner)
  byOwner.set(owner, computed)
  return computed
}

const constructorInstalledMemberDeclarationsUncachedOf = (
  flow: ValueFlowIndex,
  owner: SourceClass
): ReadonlyMap<string, readonly ts.BinaryExpression[]> => {
  const ownerFrame: ts.Node | undefined = isConstructorFunction(owner)
    ? owner
    : isClassSpelledSourceClass(owner)
      ? owner.members.find(
          (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined
        )
      : undefined
  if (!ownerFrame) return new Map()
  const found = new Map<string, ts.BinaryExpression[]>()
  for (const write of flow.allWrites) {
    if (write.slot !== 'whole') continue
    const access = write.naming
    if (!access || (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access))) continue
    const writtenKey = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
    if (writtenKey === null) continue
    const receiver = thisReceiverOf(flow, access.expression)
    if (!receiver || flow.receiverOwnerOf(receiver) !== ownerFrame) continue
    const declaration = access.parent
    if (ts.isBinaryExpression(declaration) && declaration.left === access && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let declarations = found.get(writtenKey)
      if (!declarations) found.set(writtenKey, (declarations = []))
      if (!declarations.includes(declaration)) declarations.push(declaration)
    }
  }
  return found
}

const constructorInstalledMemberWritesOf = (flow: ValueFlowIndex, owner: SourceClass, key: string): readonly ts.BinaryExpression[] =>
  constructorInstalledMemberDeclarationsOf(flow, owner).get(key) ?? []

/** Exact origins may narrow a descriptor family. Otherwise proving every member
 * of the declared family is conservative; it does not certify allocation origins. */
const familyRootsOf = (checker: ts.TypeChecker, query: SourceClassFamilyQuery): ReadonlySet<SourceClass> | null => {
  const roots = new Set<SourceClass>()
  const seen = new Set<ts.Type>()
  const collect = (type: ts.Type): boolean => {
    if (seen.has(type)) return false
    seen.add(type)
    if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return true
    if (type.isUnion()) return type.types.every(collect)
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type)
      return constraint !== undefined && constraint !== type && collect(constraint)
    }
    const classType =
      type.isClassOrInterface() ||
      ((type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
        (type as ts.TypeReference).target.isClassOrInterface())
    if (!classType) return false
    const declaration = type.getSymbol()?.valueDeclaration
    if (
      !declaration ||
      (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration) && !isConstructorFunction(declaration)) ||
      declaration.getSourceFile().isDeclarationFile
    )
      return false
    roots.add(declaration)
    return true
  }
  const exact = query.kind === 'value' ? query.originsOf(query.expression) : null
  if (exact) for (const owner of exact.classes) roots.add(owner)
  else if (!collect(query.receiver)) return null
  // TEMPORARY diagnostic for root A's real-WebGLRenderer probe -- names which
  // arm of this function supplied `roots` and how many it found, since a
  // truthy-but-EMPTY `exact` short-circuits the `collect()` fallback and
  // silently produces zero roots. Remove once the real-file refusal is found.
  const watchedFamilyRoots = process.env['GEA_FAMILY_ROOTS_DEBUG']
  if (
    watchedFamilyRoots !== undefined &&
    query.kind === 'value' &&
    (watchedFamilyRoots === '*' || query.expression.getText().includes(watchedFamilyRoots))
  ) {
    const file = query.expression.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(query.expression.getStart()).line + 1
    console.error(
      `[FAMILY-ROOTS] ${file.fileName.split('/').pop()}#${line} [${query.expression.getText().slice(0, 40)}] arm=${exact ? 'exact' : 'collect'} exactClasses=${exact ? exact.classes.size : '-'} roots=${[...roots].map((r) => r.name?.text ?? '(anonymous)').join(',')}`
    )
  }
  return roots
}

const declaredClassTypeOf = (checker: ts.TypeChecker, owner: SourceClass): ts.InterfaceType | null => {
  const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
  const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
  return type?.isClassOrInterface() ? type : null
}

/** A source family's inherited constructor slot, with no own override or recorded replacement. */
export const sourceClassConstructorSlotIsOriginal = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery
): boolean => {
  const roots = familyRootsOf(checker, query)
  const inventory = roots && ownedClassReceiverInventoryOf(checker, flow, roots)
  if (!inventory) return false
  for (const owner of inventory.classes) if (!classConstructorSlotIsOriginal(checker, flow, owner)) return false
  return true
}

/** One class's `constructor` slot is still `Object.prototype.constructor`: no own member, no recorded write. */
/**
 * Whether this class still has the `constructor` slot `Object` gave it.
 *
 * Memoized because the question is asked inside two `for` loops -- once per
 * member of a receiver family and once per class of an inventory -- while the
 * answer depends only on the flow index and the class: two checker calls, a
 * write-set lookup, and a `getSourceFile()` parent walk per declaration, all
 * of which give the same result every time. A live three.js profile put it at
 * 7.4% of self time once the proof memo stopped dominating.
 */
const constructorSlotOriginal = new WeakMap<ValueFlowIndex, WeakMap<SourceClass, boolean>>()

export const classConstructorSlotIsOriginal = (checker: ts.TypeChecker, flow: ValueFlowIndex, owner: SourceClass): boolean => {
  let byOwner = constructorSlotOriginal.get(flow)
  if (!byOwner) constructorSlotOriginal.set(flow, (byOwner = new WeakMap()))
  const known = byOwner.get(owner)
  if (known !== undefined) return known
  const answer = classConstructorSlotIsOriginalUncached(checker, flow, owner)
  byOwner.set(owner, answer)
  return answer
}

const classConstructorSlotIsOriginalUncached = (checker: ts.TypeChecker, flow: ValueFlowIndex, owner: SourceClass): boolean => {
  const type = declaredClassTypeOf(checker, owner)
  const slot = type && checker.getPropertyOfType(type, 'constructor')
  return (
    !!slot?.declarations?.length &&
    flow.writesToSymbol(slot).length === 0 &&
    slot.declarations.every(
      (declaration) =>
        declaration.getSourceFile().hasNoDefaultLib &&
        ts.isPropertySignature(declaration) &&
        ts.isInterfaceDeclaration(declaration.parent) &&
        declaration.parent.name.text === 'Object'
    )
  )
}

/** Only checker-stable queries may outlive a receiver proof. Injected caller
 * and receiver-family queries can depend on that proof's active assumptions,
 * so their answers must settle in its coinductive memo, not a global cache.
 * The receiver type is part of the key: an expression's inferred type can
 * change while the shared flow inventory remains the same. */
interface CachedPlan<R> {
  readonly value: R
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}
type AnchorCache<R> = WeakMap<ValueFlowIndex, WeakMap<object, WeakMap<ts.Type, Map<string, CachedPlan<R>>>>>
const dataMemberPlans: AnchorCache<{ readonly declarations: readonly ts.Declaration[] } | null> = new WeakMap()
const callableMemberPlans: AnchorCache<{ readonly declarations: readonly ts.Declaration[] } | null> = new WeakMap()
const keyReadPlans: AnchorCache<SourceClassKeyReadPlan | null> = new WeakMap()
// Read once at load: `process.env` is a native interceptor, and the member
// plan below runs once per uncached (anchor, receiver, key) question -- and
// once per VALUE query outright, since those are proof-local -- so a per-call
// read was a measurable slice of the three.js app's frontend for a value that cannot
// change mid-process.
const watchedOwnedClass = process.env['GEA_OWNED_CLASS_DEBUG']

const cachedByAnchorAndKey = <R>(
  store: AnchorCache<R>,
  flow: ValueFlowIndex,
  anchor: object,
  receiver: ts.Type,
  key: string,
  proofLocal: boolean,
  compute: () => R
): R => {
  if (proofLocal) return compute()
  let byAnchor = store.get(flow)
  if (!byAnchor) store.set(flow, (byAnchor = new WeakMap()))
  let byType = byAnchor.get(anchor)
  if (!byType) byAnchor.set(anchor, (byType = new WeakMap()))
  let byKey = byType.get(receiver)
  if (!byKey) byType.set(receiver, (byKey = new Map()))
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  let answer = byKey.get(key)
  if (!answer) {
    answer = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
    byKey.set(key, answer)
  }
  // A cache hit owes exactly the obligations that justified the first read.
  // Without an enclosing capture, compute again so the original fail-closed
  // requirement cannot be bypassed by an earlier successful query.
  if (answer.requirements.length > 0 && ledger?.include(answer.requirements) !== true) return compute()
  return answer.value
}

/** A descriptor-family proof, not a receiver-origin or escape proof. The
 * caller already follows a particular source owner through its aliases.
 * Unrelated function constructors with checker type `any` must not become
 * members of that owner's family merely through structural assignability.
 */
export const sourceClassDataMemberPlanOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): { readonly declarations: readonly ts.Declaration[] } | null =>
  cachedByAnchorAndKey(
    dataMemberPlans,
    flow,
    query.kind === 'value' ? query.expression : query.receiver,
    query.receiver,
    key,
    query.kind === 'value',
    () => sourceClassDataMemberPlanUncached(checker, flow, query, key)
  )

const sourceClassDataMemberPlanUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): { readonly declarations: readonly ts.Declaration[] } | null => {
  if (key === '__proto__' || key === 'constructor') return null
  const roots = familyRootsOf(checker, query)
  if (!roots) return null
  const watched = watchedOwnedClass
  const watching = watched !== undefined && [...roots].some((root) => (root.name?.text ?? '') === watched)
  const refuse = (reason: string, detail?: string): null => {
    if (watching) console.error(`[SOURCE-CLASS-DATA] ${watched}.${key} ${reason}${detail ? ` ${detail}` : ''}`)
    return null
  }
  if (roots.size === 0) return null
  const inventory = ownedClassReceiverInventoryOf(checker, flow, roots)
  if (!inventory) return refuse('no-inventory')
  const declarations = new Set<ts.Declaration>()
  for (const owner of inventory.classes) {
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    if (!symbol) return refuse('unnamed-owner')
    const ownerType = checker.getDeclaredTypeOfSymbol(symbol)
    const member = checker.getPropertyOfType(ownerType, key)
    if (!member?.declarations?.length) {
      const installed = constructorInstalledMemberWritesOf(flow, owner, key)
      if (installed.length === 0) return refuse('member-absent-on-owner', owner.name?.text)
      for (const declaration of installed) declarations.add(declaration)
      continue
    }
    if (!member.declarations.every(isSourceDataDeclaration)) {
      const passthrough = accessorPassthroughDataMemberOf(checker, flow, ownerType, member)
      if (!passthrough) return refuse('member-not-data-on-owner', owner.name?.text)
      declarations.add(passthrough.declaration)
      continue
    }
    declarations.add(member.valueDeclaration ?? member.declarations[0]!)
  }
  return { declarations: [...declarations] }
}

export const sourceClassDataMemberOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, receiver: ts.Type, key: string): boolean =>
  sourceClassDataMemberPlanOf(checker, flow, { kind: 'declared', receiver }, key) !== null

/**
 * The source method bodies a key resolves to on this class family.
 *
 * A sibling of `sourceClassDataMemberPlanOf`, deliberately not a widening of
 * it. They answer different questions -- "what plain data does this key hold"
 * and "which bodies does this key dispatch to" -- and a consumer asking the
 * first must keep getting `null` for a method, so they get separate caches as
 * well as separate names.
 *
 * **Slot integrity is not proven here, and that separation is the point.**
 * `ownedClassReceiverInventoryOf` admits a family only when
 * `classConstructorKeepsInstanceOf` holds for every class in it, and that
 * inventory refuses any constructor or prototype reference it cannot explain,
 * `C.prototype.m = other` included. What remains -- an instance-side `a.m = f`
 * -- belongs to whoever holds the construction: the value graph's slot transfer
 * enumerates every write to this key on that allocation and refuses the ones it
 * cannot model. This function answers only which declarations the key names,
 * which is §4's distinction between a virtual callable slot and prototype-slot
 * integrity, kept apart on purpose.
 */
export const sourceClassCallableMemberPlanOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): { readonly declarations: readonly ts.Declaration[] } | null =>
  cachedByAnchorAndKey(
    callableMemberPlans,
    flow,
    query.kind === 'value' ? query.expression : query.receiver,
    query.receiver,
    key,
    query.kind === 'value',
    () => sourceClassCallableMemberPlanUncached(checker, flow, query, key)
  )

const sourceClassCallableMemberPlanUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): { readonly declarations: readonly ts.Declaration[] } | null => {
  if (key === '__proto__' || key === 'constructor') return null
  const roots = familyRootsOf(checker, query)
  if (!roots || roots.size === 0) return null
  const watched = watchedOwnedClass
  const watching = watched !== undefined && [...roots].some((root) => (root.name?.text ?? '') === watched)
  const refuse = (reason: string, detail?: string): null => {
    if (watching) console.error(`[SOURCE-CLASS-CALLABLE] ${watched}.${key} ${reason}${detail ? ` ${detail}` : ''}`)
    return null
  }
  const inventory = ownedClassReceiverInventoryOf(checker, flow, roots)
  if (!inventory) return refuse('no-inventory')
  const declarations = new Set<ts.Declaration>()
  for (const owner of inventory.classes) {
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    if (!symbol) return refuse('unnamed-owner')
    const member = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), key)
    if (!member?.declarations?.length) return refuse('member-absent-on-owner', owner.name?.text)
    // Every declaration, on every class the receiver can be: one override that
    // is an accessor, a bodiless overload or an ambient member makes the whole
    // family's answer unknown rather than partly known.
    if (!member.declarations.every(isSourceInstanceMethod)) return refuse('member-not-a-source-method', owner.name?.text)
    for (const declaration of member.declarations) declarations.add(declaration)
  }
  return { declarations: [...declarations] }
}

/** How one family class answers a read of the key: no member anywhere on its
 * chain, a plain data member, or something that runs code or cannot be seen. */
export type SourceClassKeyRead = 'absent' | 'data' | 'other'

export interface SourceClassKeyReadPlan {
  /** Every class the receiver can be an instance of, classified for the key. */
  readonly classes: ReadonlyMap<SourceClass, SourceClassKeyRead>
  /** The declared data member of every `data` class, with its checker carrier. */
  readonly carriers: readonly { readonly owner: SourceClass; readonly declaration: ts.Declaration; readonly type: ts.Type }[]
  /** No class on any family chain has a method, accessor or unseen member for the key. */
  readonly codeFree: boolean
  /** Every carrier is a primitive, `null` or `undefined`: the read can never yield an object. */
  readonly primitive: boolean
  /** Some class lacks the key, so its read falls through to the intrinsic Object prototype. */
  readonly needsDefaultPrototype: boolean
  /** Complete source setters a plain assignment can execute, or null when its effects are opaque. */
  readonly writeBodies: readonly ts.SetAccessorDeclaration[] | null
  /** Complete source getters a read executes, or null when a read's effects are opaque (a method, an unseen member kind, a bodiless getter). */
  readonly readBodies: readonly ts.GetAccessorDeclaration[] | null
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void
const primitiveType = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(primitiveType) : (type.flags & PRIMITIVE_FLAGS) !== 0)

/**
 * A read of `key` through a receiver of this source class family, classified
 * per class -- including keys the receiver's own class never declares.
 *
 * Three's renderer asks every drawable `object.isInstancedMesh` and
 * `object.isSkinnedMesh` (`WebGLRenderLists.js`, `WebGLObjects.js`,
 * `WebGLPrograms.js`, ...). Only `InstancedMesh`/`SkinnedMesh` declare them,
 * and neither is in the three.js app's import graph, so on a `Mesh` the read is simply
 * absent. The read runs no code exactly when no class in the family -- nor
 * any class on its prototype chain up to `Object.prototype` -- has a method
 * or accessor for the key. An absent key further needs the key not to be an
 * `Object.prototype` member and the intrinsic Object prototype intact (the
 * same ledger obligation a record's missing slot pays).
 *
 * `carriers`/`primitive` let a caller that follows the receiver require that
 * the read can never yield the receiver back (`this.self = this`) or a
 * function that captures it. "Absent" states that no class DECLARES the key;
 * an expando store onto an instance is a store the caller's own publication
 * tracking must see. Like the data plan, this assumes a receiver typed as a
 * family class really holds a family instance.
 */
export const sourceClassKeyReadPlanOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): SourceClassKeyReadPlan | null =>
  cachedByAnchorAndKey(
    keyReadPlans,
    flow,
    query.kind === 'value' ? query.expression : query.receiver,
    query.receiver,
    key,
    query.kind === 'value',
    () => sourceClassKeyReadPlanUncached(checker, flow, query, key)
  )

const sourceClassKeyReadPlanUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: SourceClassFamilyQuery,
  key: string
): SourceClassKeyReadPlan | null => {
  // `toString`, `hasOwnProperty`, `__proto__`, `constructor`: every instance
  // reaches the intrinsic member, and a family class may also shadow it.
  if (objectPrototypeMemberNames.has(key)) return null
  const roots = familyRootsOf(checker, query)
  if (!roots || roots.size === 0) return null
  const inventory = ownedClassReceiverInventoryOf(checker, flow, roots)
  if (!inventory) return null
  const interfaceOf = (type: ts.Type): ts.InterfaceType | null => {
    if (type.isClassOrInterface()) return type
    if ((type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) {
      const target = (type as ts.TypeReference).target
      return target.isClassOrInterface() ? target : null
    }
    return null
  }
  // Every link must be a source class: a declaration-file base states
  // accessors and data properties in the same spelling, so it cannot say
  // which one a read would reach.
  const chainOf = (type: ts.InterfaceType, seen: Set<ts.Type>): ts.Type[] | null => {
    if (seen.has(type)) return []
    seen.add(type)
    const chain: ts.Type[] = [type]
    for (const base of checker.getBaseTypes(type)) {
      const declared = interfaceOf(base)
      const declaration = base.getSymbol()?.valueDeclaration
      if (
        !declared ||
        !declaration ||
        (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) ||
        declaration.getSourceFile().isDeclarationFile
      )
        return null
      const rest = chainOf(declared, seen)
      if (!rest) return null
      chain.push(base, ...rest)
    }
    return chain
  }
  const classes = new Map<SourceClass, SourceClassKeyRead>()
  const carriers: { owner: SourceClass; declaration: ts.Declaration; type: ts.Type }[] = []
  let codeFree = true
  let primitive = true
  let absent = false
  const writeBodies = new Set<ts.SetAccessorDeclaration>()
  let writesKnown = true
  const readBodies = new Set<ts.GetAccessorDeclaration>()
  let readsKnown = true
  for (const owner of inventory.classes) {
    const type = declaredClassTypeOf(checker, owner)
    const chain = type ? chainOf(type, new Set()) : null
    if (!type || !chain) return null
    let verdict: SourceClassKeyRead = 'absent'
    for (const link of chain) {
      const member = checker.getPropertyOfType(link, key)
      if (!member) continue
      if (!member.declarations?.length || !member.declarations.every(isSourceDataDeclaration)) {
        // Reading and assigning the same key invoke different code. A source
        // setter can be inspected even when its getter is not transparent.
        // A getter-only property throws (or ignores a sloppy assignment), so
        // that write contributes no receiver publication either.
        if (
          member.declarations?.length &&
          member.declarations.every(
            (declaration) => !declaration.getSourceFile().isDeclarationFile && ts.isMethodDeclaration(declaration)
          ) &&
          member.declarations.some((declaration) => ts.isMethodDeclaration(declaration) && declaration.body !== undefined)
        ) {
          // Source methods install ordinary writable data descriptors. A
          // store shadows that method on the instance without invoking the
          // old or new callable. Reading/calling it remains a separate proof.
          readsKnown = false
        } else if (
          member.declarations?.length &&
          member.declarations.every(
            (declaration) =>
              !declaration.getSourceFile().isDeclarationFile &&
              (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration))
          )
        ) {
          for (const declaration of member.declarations) {
            if (ts.isSetAccessorDeclaration(declaration)) {
              if (declaration.body) writeBodies.add(declaration)
              else writesKnown = false
            } else if (ts.isGetAccessorDeclaration(declaration)) {
              if (declaration.body) readBodies.add(declaration)
              else readsKnown = false
            }
          }
        } else {
          writesKnown = false
          readsKnown = false
        }
        // Not a plain data declaration on this link -- still `data` when it
        // is instead an accessor pair provably forwarding to one; see
        // `accessorPassthroughDataMemberOf`'s header for why this cannot
        // widen the read past what a real data member would have permitted.
        if (member.declarations?.length && accessorPassthroughDataMemberOf(checker, flow, link, member)) {
          verdict = 'data'
          continue
        }
        verdict = 'other'
        break
      }
      verdict = 'data'
    }
    // No link on the checker's own chain declares the key at all -- which is
    // exactly what a constructor function writing it only through a `this`
    // alias looks like, since the checker's inference never saw that write
    // either. Fall back to the flow-index's own record of it before reading
    // this as a genuine absence and requiring the intrinsic Object prototype
    // to stay clean for a key the program plainly does assign.
    if (verdict === 'absent') {
      const installed = constructorInstalledMemberWritesOf(flow, owner, key)
      if (installed.length > 0) {
        for (const declaration of installed) {
          const carrier = checker.getTypeAtLocation(declaration.right)
          carriers.push({ owner, declaration, type: carrier })
          primitive &&= primitiveType(carrier)
        }
        classes.set(owner, 'data')
        continue
      }
    }
    if (verdict === 'data') {
      const member = checker.getPropertyOfType(type, key)!
      const passthrough =
        member.declarations?.length && !member.declarations.every(isSourceDataDeclaration)
          ? accessorPassthroughDataMemberOf(checker, flow, type, member)
          : null
      const declaration = passthrough ? passthrough.declaration : (member.valueDeclaration ?? member.declarations![0]!)
      const carrier = passthrough ? passthrough.type : checker.getTypeOfSymbolAtLocation(member, declaration)
      carriers.push({ owner, declaration, type: carrier })
      primitive &&= primitiveType(carrier)
    } else if (verdict === 'other') codeFree = false
    else absent = true
    classes.set(owner, verdict)
  }
  if (absent) {
    if (objectPrototypeMemberNames.has(key)) return null
    const location = query.kind === 'value' ? query.expression : roots.values().next().value!
    // The read falls through to Object.prototype for exactly this key, so the
    // obligation is that key's absence there -- not the whole prototype, which
    // any unattributed write anywhere in the program fails.
    if (deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys('Object', { names: [key] }, location) !== true) return null
  }
  return {
    classes,
    carriers,
    codeFree,
    primitive,
    needsDefaultPrototype: absent,
    writeBodies: writesKnown ? [...writeBodies] : null,
    readBodies: readsKnown ? [...readBodies] : null
  }
}

/** `Object.<method>`/`Reflect.<method>` calls, and the legacy per-instance
 * pair, whose effect is INSTALLING an accessor under some key -- as opposed
 * to `Object.assign`/`Reflect.set`, which only ever write THROUGH an
 * existing accessor (or create a plain data property) rather than install a
 * new one. `setPrototypeOf` is here because a replaced prototype can bring
 * any accessor with it, under any key. */
const REFLECTIVE_ACCESSOR_INSTALLERS: ReadonlySet<string> = new Set(['defineProperty', 'defineProperties', 'setPrototypeOf'])

/** A mention of the global `Object`/`Reflect` value that cannot hand one of
 * its mutators out: a member read (the member's own symbol is then scanned
 * separately), a call or construction of it, or an identity/`instanceof`
 * comparison. Mirrors `class-family-member-read.ts`'s `globalValueUseIsInert`,
 * kept as its own small copy rather than imported -- see
 * `reflectiveDefinitionMayInstallGetterOf`'s header for why. */
const globalValueUseIsInert = (reference: ts.Node): boolean => {
  let node = reference
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === node
  return (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
  )
}

/** Whether an object-literal descriptor MAP (`defineProperties`'s second
 * argument, or a `__defineGetter__`-style name argument) can be ruled out
 * from naming `key` -- conservatively `true` (may name) for anything that is
 * not a spread-free literal with every property name spelled out. */
const literalMayNameKey = (expression: ts.Expression | undefined, key: string): boolean => {
  if (!expression) return true
  if (ts.isParenthesizedExpression(expression)) return literalMayNameKey(expression.expression, key)
  if (!ts.isObjectLiteralExpression(expression)) return true
  return expression.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true
    const propertyName = property.name
    if (!propertyName) return true
    if (ts.isComputedPropertyName(propertyName)) return true
    if (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) || ts.isNumericLiteral(propertyName))
      return propertyName.text === key
    return true
  })
}

/** Whether a single NAME argument (`defineProperty`'s key, `__defineGetter__`'s
 * name) can be ruled out from naming `key` -- conservatively `true` for
 * anything but a matching string/numeric literal. */
const namedArgumentMayNameKey = (argument: ts.Expression | undefined, key: string): boolean => {
  if (!argument) return true
  if (ts.isParenthesizedExpression(argument)) return namedArgumentMayNameKey(argument.expression, key)
  if (ts.isSpreadElement(argument)) return true
  if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) return argument.text === key
  return true
}

const reflectiveDefinitions = new WeakMap<ValueFlowIndex, Map<string, boolean>>()

/**
 * Whether any reflective definition anywhere in the program -- `Object.defineProperty`/
 * `defineProperties`, `Reflect.defineProperty`, `x.__defineGetter__`/`__defineSetter__`,
 * a prototype swap, or an unaccounted-for alias of one of the `Object`/`Reflect`
 * mutators -- could install a GETTER under `key` on some object.
 *
 * `sourceClassKeyReadPlanOf` classifies a key from the checker's own STATIC
 * declared members; it has no way to see an accessor a reflective call
 * installs on one instance at runtime, on a class the checker still types as
 * plain data. A member-read proof built on that plan must refuse whenever
 * this holds, however data-only the plan itself says the family is.
 *
 * Deliberately conservative and receiver-blind: it does not try to prove the
 * reflective call's TARGET cannot be one of this proof's family instances --
 * that precision is `class-family-member-read.ts`'s own (unexported)
 * `reflectionMayCreate`, not reused here because importing it would cycle
 * back through `callable-reach.ts`, which `class-family-member-read.ts`
 * itself imports (`closedCallableAuthorityOf`). Over-refusing is always
 * sound: this can only ever make a read refuse, never accept one it should
 * not have. `Object.assign`/`Reflect.set` are deliberately excluded -- both
 * write through [[Set]], which invokes an EXISTING accessor or creates a
 * plain data property, but installs no new one.
 */
export const reflectiveDefinitionMayInstallGetterOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, key: string): boolean => {
  let byKey = reflectiveDefinitions.get(flow)
  if (!byKey) reflectiveDefinitions.set(flow, (byKey = new Map()))
  const held = byKey.get(key)
  if (held !== undefined) return held
  const answer = computeReflectiveDefinitionMayInstallGetter(checker, flow, key)
  byKey.set(key, answer)
  return answer
}

const computeReflectiveDefinitionMayInstallGetter = (checker: ts.TypeChecker, flow: ValueFlowIndex, key: string): boolean => {
  const directCallees = new Set<ts.Node>()
  for (const { call } of flow.calls) {
    if (!ts.isCallExpression(call)) continue
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee)) continue
    // `x.__defineGetter__( 'key', fn )` / `x.__defineSetter__( ... )`: a
    // direct per-instance call, on any receiver -- conservatively not
    // narrowed to whether `x` could be a family instance, same as the rest
    // of this scan.
    if (callee.name.text === '__defineGetter__' || callee.name.text === '__defineSetter__') {
      if (namedArgumentMayNameKey(call.arguments[0], key)) return true
      continue
    }
    if (!ts.isIdentifier(callee.expression)) continue
    const method = callee.name.text
    if (!REFLECTIVE_ACCESSOR_INSTALLERS.has(method)) continue
    const owner = callee.expression
    const isObject = isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner))
    const isReflect = !isObject && isStandardGlobalValue(checker, owner, 'Reflect')
    if (!isObject && !isReflect) continue
    directCallees.add(callee.name)
    if (method === 'setPrototypeOf') return true
    if (method === 'defineProperty') {
      if (namedArgumentMayNameKey(call.arguments[1], key)) return true
    } else if (literalMayNameKey(call.arguments[1], key)) return true
  }
  // An unaccounted mention of `Object`/`Reflect` -- passed along, destructured,
  // read for a member other than as a recorded direct callee -- hands its
  // mutators out unnamed; nothing here can then rule them out.
  for (const global of ['Object', 'Reflect']) {
    let value = checker.resolveName(global, undefined, ts.SymbolFlags.Value, false)
    if (value && (value.flags & ts.SymbolFlags.Alias) !== 0) value = checker.getAliasedSymbol(value)
    if (!value) continue
    for (const reference of flow.memberReferencesToSymbol(value)) if (!globalValueUseIsInert(reference)) return true
    const valueType = checker.getTypeOfSymbol(value)
    for (const method of REFLECTIVE_ACCESSOR_INSTALLERS) {
      const member = checker.getPropertyOfType(valueType, method)
      if (!member) continue
      for (const reference of flow.memberReferencesToSymbol(member)) if (!directCallees.has(reference)) return true
    }
  }
  return false
}
