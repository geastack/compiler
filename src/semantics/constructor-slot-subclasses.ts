import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/**
 * Which DERIVED class constructors the program stores into a slot typed as a
 * base class's constructor, keyed by the base.
 *
 * `typeof Base` is the checker's type for the `Base` identifier AND for any
 * cell declared with it, and `representation/derive.ts` gives it a
 * constructor family whose one member is `Base`. That member list is a
 * promise every consumer cashes: construction inlines `Base`'s initializer
 * (`ir/native-class-construction.ts`), static reads resolve to `Base`'s
 * members. `var Request: typeof RequestImpl = RequestImpl`, later replaced by
 * a library's own subclass, breaks the promise -- `new Request()`
 * must build the subclass -- so the family has to name every class the
 * program can put there, and that is a fact about the program's WRITES, which
 * only this layer can see.
 *
 * A write is: a value position whose contextual type is `typeof Base`
 * (an assignment, an annotated initializer, an argument, a return, an object
 * literal property), plus `Object.defineProperty(G, 'K', { value: V })`,
 * whose descriptor's `value` is `any` to the checker but lands in `G.K`, typed
 * by `G`'s own declaration. Only a PROPER subclass is recorded: an unrelated
 * class of the same shape has no base subobject to upcast through, so its
 * store stays refused by the conversion census rather than being admitted
 * here.
 */
export const constructorSlotSubclassesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlyMap<DeclarationId, readonly DeclarationId[]> => {
  const subclasses = new Map<DeclarationId, DeclarationId[]>()

  // The static side of a class only: `typeof C` is the type of the class
  // symbol's value, while the instance type shares the symbol.
  const classOfConstructorType = (type: ts.Type): DeclarationId | null => {
    const symbol = type.getSymbol()
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return null
    const node = symbol.declarations?.find((candidate) => ts.isClassLike(candidate))
    if (!node || checker.getTypeOfSymbol(symbol) !== type) return null
    return identities.declarationIdOf(node)
  }

  // `x.constructor` is the constructor of whichever class `x` was allocated
  // as: its static class or any class extending it. `lib.es5.d.ts` types the
  // read `Function`, so a program stores it into a `typeof Base` slot through
  // `as any` -- a library that hands
  // `this.searchParams.constructor as any` to a `typeof URLSearchParams`
  // mixin parameter -- and every class it can be is a write of its own.
  const constructorReadClassOf = (source: ts.Expression): DeclarationId | null => {
    let inner = source
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isSatisfiesExpression(inner)
    )
      inner = inner.expression
    if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== 'constructor') return null
    const instance = checker.getTypeAtLocation(inner.expression)
    const symbol = instance.getSymbol()
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return null
    const node = symbol.declarations?.find((candidate) => ts.isClassLike(candidate))
    if (!node || ((instance as ts.TypeReference).target ?? instance) !== checker.getDeclaredTypeOfSymbol(symbol)) return null
    return identities.declarationIdOf(node)
  }

  const record = (target: ts.Type | undefined, source: ts.Expression): void => {
    if (!target) return
    const read = constructorReadClassOf(source)
    if (read !== null) {
      for (const [candidate, ancestors] of heritage) if (candidate === read || ancestors.includes(read)) recordDerived(target, candidate)
      recordDerived(target, read)
      return
    }
    const derivedType = checker.getTypeAtLocation(source)
    const derived = classOfConstructorType(derivedType)
    if (derived === null) return
    recordDerived(target, derived)
    recordThroughConvention(target, derivedType, derived)
  }

  /**
   * A class stored into a STRUCTURAL constructor slot -- `{ new (bytes):
   * Reply; make(bytes): Reply }` -- is a write into every ancestor's
   * `typeof Base` that fits the same slot.
   *
   * The statement names no class, but the census may hold the slot to the
   * classes its callers pass (`narrowsStructuralConstructorToClasses`), and
   * the checker then subtype-reduces `typeof Derived | typeof Base` to
   * `typeof Base`: `responseType ?? BaseResponse` over a `DerivedResponse`
   * argument is typed `typeof BaseResponse`. That family
   * has to name the subclass, or the checked projection into it refuses the
   * very class the caller handed in.
   */
  const recordThroughConvention = (target: ts.Type, derivedType: ts.Type, derived: DeclarationId): void => {
    const conventions = (target.isUnion() ? target.types : [target]).filter(
      (arm) =>
        (arm.flags & ts.TypeFlags.Object) !== 0 &&
        classOfConstructorType(arm) === null &&
        arm.getConstructSignatures().length > 0 &&
        arm.getCallSignatures().length === 0
    )
    if (conventions.length === 0) return
    const symbol = derivedType.getSymbol()
    if (!symbol) return
    const seen = new Set<ts.Type>()
    let frontier: readonly ts.BaseType[] = checker.getBaseTypes(checker.getDeclaredTypeOfSymbol(symbol) as ts.InterfaceType)
    while (frontier.length > 0) {
      const next: ts.BaseType[] = []
      for (const base of frontier) {
        const target = (base as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? (base as ts.TypeReference).target : base
        if (seen.has(target)) continue
        seen.add(target)
        const baseSymbol = target.getSymbol()
        if (!baseSymbol || (baseSymbol.flags & ts.SymbolFlags.Class) === 0) continue
        const baseConstructor = checker.getTypeOfSymbol(baseSymbol)
        if (conventions.some((convention) => checker.isTypeAssignableTo(baseConstructor, convention)))
          recordDerived(baseConstructor, derived)
        if (target.isClassOrInterface()) next.push(...checker.getBaseTypes(target))
      }
      frontier = next
    }
  }

  const recordDerived = (target: ts.Type, derived: DeclarationId): void => {
    const ancestors = heritage.get(derived) ?? []
    for (const arm of target.isUnion() ? target.types : [target]) {
      const base = classOfConstructorType(arm)
      if (base === null || base === derived || !ancestors.includes(base)) continue
      const known: DeclarationId[] = subclasses.get(base) ?? []
      if (!known.includes(derived)) known.push(derived)
      subclasses.set(base, known)
    }
  }

  const isObjectDefineProperty = (call: ts.CallExpression): boolean => {
    const callee = call.expression
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'defineProperty' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object'
    )
  }

  const recordDefinedValue = (call: ts.CallExpression): void => {
    const [holder, key, descriptor] = call.arguments
    if (!holder || !key || !descriptor || !ts.isStringLiteralLike(key) || !ts.isObjectLiteralExpression(descriptor)) return
    const value = descriptor.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'value'
    )
    if (!value) return
    const slot = checker.getPropertyOfType(checker.getTypeAtLocation(holder), key.text)
    if (slot) record(checker.getTypeOfSymbolAtLocation(slot, call), value.initializer)
  }

  // The source is looked at only where a constructor can plausibly be named;
  // asking the checker for every expression's type would cost the whole walk.
  const isNamedValue = (node: ts.Expression): boolean => {
    let inner = node
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression
    return (
      ts.isIdentifier(inner) ||
      ts.isPropertyAccessExpression(inner) ||
      ts.isClassExpression(inner) ||
      constructorReadClassOf(inner) !== null
    )
  }

  // A conditional or a `??`/`||`/`&&` chain stores whichever arm it picks, so
  // each arm that names a constructor is a write of its own:
  // `this.RESPONSE_TYPE = explain ? ExplainedResponse : Response` puts either
  // class in the slot.
  const namedArmsOf = (node: ts.Expression): ts.Expression[] => {
    let inner = node
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression
    if (ts.isConditionalExpression(inner)) return [...namedArmsOf(inner.whenTrue), ...namedArmsOf(inner.whenFalse)]
    if (ts.isBinaryExpression(inner)) {
      const operator = inner.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return namedArmsOf(inner.right)
      if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
        return [...namedArmsOf(inner.left), ...namedArmsOf(inner.right)]
      }
    }
    return isNamedValue(inner) ? [inner] : []
  }

  // A field that overrides a base member is the SAME slot as far as the base's
  // code is concerned: `abstract RESPONSE_TYPE: typeof Response` read by the
  // base's `new this.RESPONSE_TYPE(bytes)` sees what a subclass's
  // `override RESPONSE_TYPE = ListResponse` (whose own type the checker
  // narrows to `typeof ListResponse`) or `this.RESPONSE_TYPE = ...` stores. So
  // a write into a class's own field is also a write into every same-named
  // member of its base classes, at that member's declared type.
  const overriddenSlotTypesOf = (owner: ts.ClassLikeDeclaration, name: string, at: ts.Node): ts.Type[] => {
    const types: ts.Type[] = []
    const seen = new Set<ts.Type>()
    const pending: ts.Type[] = []
    const ownerType = checker.getTypeAtLocation(owner)
    const pushBases = (type: ts.Type): void => {
      if (!(type.flags & ts.TypeFlags.Object) || !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) return
      for (const base of checker.getBaseTypes(type as ts.InterfaceType)) pending.push(base)
    }
    pushBases(ownerType)
    while (pending.length > 0) {
      const base = pending.pop()!
      if (seen.has(base)) continue
      seen.add(base)
      const member = checker.getPropertyOfType(base, name)
      if (member) types.push(checker.getTypeOfSymbolAtLocation(member, at))
      const target = (base as ts.TypeReference).target ?? base
      pushBases(target)
    }
    return types
  }

  const recordArms = (target: ts.Type | undefined, value: ts.Expression): void => {
    for (const arm of namedArmsOf(value)) record(target, arm)
  }

  const recordOverriddenWrites = (node: ts.Node): void => {
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isClassLike(node.parent) && !ts.isComputedPropertyName(node.name)) {
      const name = node.name.getText()
      for (const type of overriddenSlotTypesOf(node.parent, name, node)) recordArms(type, node.initializer)
      return
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const owner = checker.getSymbolAtLocation(node.left.name)?.declarations?.find((declaration) => ts.isClassLike(declaration.parent))
      if (!owner || !ts.isClassLike(owner.parent)) return
      for (const type of overriddenSlotTypesOf(owner.parent, node.left.name.text, node)) recordArms(type, node.right)
    }
  }

  const valuePosition = (node: ts.Node): ts.Expression | null => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return node.right
    if (ts.isVariableDeclaration(node) && node.type && node.initializer) return node.initializer
    if (ts.isPropertyDeclaration(node) && node.type && node.initializer) return node.initializer
    if (ts.isReturnStatement(node) && node.expression) return node.expression
    if (ts.isPropertyAssignment(node)) return node.initializer
    return null
  }

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      const value = valuePosition(node)
      if (value && namedArmsOf(value).length > 0) recordArms(checker.getContextualType(value), value)
      recordOverriddenWrites(node)
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const argument of node.arguments ?? []) if (isNamedValue(argument)) record(checker.getContextualType(argument), argument)
        if (ts.isCallExpression(node) && isObjectDefineProperty(node)) recordDefinedValue(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  return subclasses
}
